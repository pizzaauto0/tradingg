"""Live-Broker für Solana (Phantom-kompatible Wallet) über den Jupiter-Aggregator.

Handelt SOL <-> USDC mit einer eigenen Bot-Wallet. Anders als bei einer Börse gibt es
KEINE Stop-Order bei der Gegenseite: der Stop-Loss wird vom Bot überwacht und bei
Auslösung per Swap verkauft. Fällt der Bot/Rechner aus, ist die Position ungeschützt.
"""
from __future__ import annotations

import base64
import json
import logging
import math
import os
import time
import uuid
from typing import Any, Optional

import requests

from .config import Config
from .execution import Fill, InsufficientFunds, Position, SpotLongOnly

log = logging.getLogger(__name__)

SOL_MINT = "So11111111111111111111111111111111111111112"
SOL_DECIMALS, USDC_DECIMALS = 9, 6
BASE_TX_FEE_LAMPORTS = 5000


KEYRING_SERVICE = "tradingbot-solana"


def keyring_get() -> str:
    try:
        import keyring

        return keyring.get_password(KEYRING_SERVICE, "private_key") or ""
    except Exception:  # noqa: BLE001 - kein Schlüsselbund verfügbar
        return ""


def keyring_set(secret: str) -> None:
    import keyring

    keyring.set_password(KEYRING_SERVICE, "private_key", secret.strip())


def load_keypair(secret: str):
    """Akzeptiert Phantom-Export (Base58) oder ein JSON-Array mit 64 Bytes (Solana-CLI-Format)."""
    from solders.keypair import Keypair

    secret = secret.strip()
    if secret.startswith("["):
        return Keypair.from_bytes(bytes(json.loads(secret)))
    return Keypair.from_base58_string(secret)


class SolanaBroker(SpotLongOnly):
    mode = "live"

    def __init__(self, cfg: Config, session: Any = None, keypair: Any = None):
        self.cfg = cfg
        self.sc = cfg.solana
        self.http = session or requests.Session()
        if keypair is None:
            secret = os.environ.get(self.sc.private_key_env, "") or keyring_get()
            if not secret:
                raise ValueError("Kein Solana-Schlüssel gefunden (Umgebungsvariable oder 'python main.py set-key').")
            keypair = load_keypair(secret)
        self.kp = keypair
        self.owner = str(keypair.pubkey())

    # ----------------------------------------------------------------- rpc
    def _rpc(self, method: str, params: list) -> Any:
        resp = self.http.post(self.sc.rpc_url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
                              timeout=20)
        resp.raise_for_status()
        body = resp.json()
        if "error" in body:
            raise RuntimeError(f"RPC {method}: {body['error']}")
        return body["result"]

    def sol_balance(self) -> float:
        return self._rpc("getBalance", [self.owner, {"commitment": "confirmed"}])["value"] / 10 ** SOL_DECIMALS

    def usdc_balance(self) -> float:
        res = self._rpc("getTokenAccountsByOwner", [self.owner, {"mint": self.sc.usdc_mint},
                                                    {"encoding": "jsonParsed", "commitment": "confirmed"}])
        return float(sum(a["account"]["data"]["parsed"]["info"]["tokenAmount"]["uiAmount"] or 0
                         for a in res["value"]))

    def cash(self) -> float:
        return self.usdc_balance()

    def base_balance(self, symbol: str) -> float:
        return max(self.sol_balance() - self.sc.sol_reserve, 0.0)

    # ------------------------------------------------------------- jupiter
    def _quote(self, in_mint: str, out_mint: str, amount_raw: int) -> dict:
        resp = self.http.get(f"{self.sc.jupiter_url}/quote", params={
            "inputMint": in_mint, "outputMint": out_mint, "amount": str(amount_raw),
            "slippageBps": self.sc.slippage_bps, "restrictIntermediateTokens": "true"}, timeout=20)
        resp.raise_for_status()
        return resp.json()

    def _swap_tx(self, quote: dict) -> str:
        resp = self.http.post(f"{self.sc.jupiter_url}/swap", json={
            "quoteResponse": quote, "userPublicKey": self.owner, "wrapAndUnwrapSol": True,
            "prioritizationFeeLamports": self.sc.priority_fee_lamports}, timeout=30)
        resp.raise_for_status()
        return resp.json()["swapTransaction"]

    def _sign_and_send(self, b64_tx: str) -> str:
        from solders.transaction import VersionedTransaction

        tx = VersionedTransaction.from_bytes(base64.b64decode(b64_tx))
        signed = VersionedTransaction(tx.message, [self.kp])
        return self._rpc("sendTransaction", [base64.b64encode(bytes(signed)).decode(),
                                             {"encoding": "base64", "skipPreflight": False, "maxRetries": 3}])

    def _confirm(self, signature: str, timeout_s: int = 60) -> None:
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            status = self._rpc("getSignatureStatuses", [[signature], {"searchTransactionHistory": True}])["value"][0]
            if status:
                if status.get("err"):
                    raise RuntimeError(f"Transaktion {signature} fehlgeschlagen: {status['err']}")
                if status.get("confirmationStatus") in ("confirmed", "finalized"):
                    return
            time.sleep(2)
        raise RuntimeError(f"Transaktion {signature} nicht bestätigt (Status unklar – Wallet prüfen!)")

    def _check_quote(self, quote: dict, side: str, ref_price: float) -> None:
        in_amt, out_amt = int(quote["inAmount"]), int(quote["outAmount"])
        if side == "buy":
            price = (in_amt / 10 ** USDC_DECIMALS) / (out_amt / 10 ** SOL_DECIMALS)
        else:
            price = (out_amt / 10 ** USDC_DECIMALS) / (in_amt / 10 ** SOL_DECIMALS)
        deviation = abs(price / ref_price - 1) * 100
        if deviation > self.sc.max_deviation_pct:
            raise RuntimeError(f"Jupiter-Preis {price:.4f} weicht {deviation:.2f}% von Referenz {ref_price:.4f} ab – abgebrochen")
        impact = float(quote.get("priceImpactPct") or 0) * 100
        if impact > self.sc.max_price_impact_pct:
            raise RuntimeError(f"Preisauswirkung {impact:.2f}% zu hoch – abgebrochen")

    def _swap(self, side: str, amount_raw: int, ref_price: float) -> tuple[float, float, float]:
        """Führt den Swap aus. Gibt (SOL-Menge, Ø-Preis in USDC, Gebühr in USDC) anhand der Wallet-Salden zurück."""
        in_mint, out_mint = (self.sc.usdc_mint, SOL_MINT) if side == "buy" else (SOL_MINT, self.sc.usdc_mint)
        quote = self._quote(in_mint, out_mint, amount_raw)
        self._check_quote(quote, side, ref_price)
        sol0, usdc0 = self.sol_balance(), self.usdc_balance()
        signature = self._sign_and_send(self._swap_tx(quote))
        log.info("Solana-Swap %s gesendet: %s", side, signature)
        self._confirm(signature)
        sol1, usdc1 = self.sol_balance(), self.usdc_balance()
        fee_sol = (BASE_TX_FEE_LAMPORTS + self.sc.priority_fee_lamports) / 10 ** SOL_DECIMALS
        sol_moved = abs((sol1 - sol0) + (fee_sol if side == "buy" else -fee_sol))
        usdc_moved = abs(usdc1 - usdc0)
        if sol_moved <= 0 or usdc_moved <= 0:
            raise RuntimeError(f"Swap {signature} bestätigt, aber keine Saldenänderung erkannt – Wallet prüfen!")
        price = usdc_moved / sol_moved
        return sol_moved, price, fee_sol * price

    # --------------------------------------------------------------- broker
    def open_long(self, symbol: str, amount: float, stop: float, ref_price: float) -> Fill:
        buffer = 1 + self.sc.slippage_bps / 10_000 + 0.001
        spend = min(amount * ref_price * buffer, self.usdc_balance())
        if spend < 1.0:
            raise InsufficientFunds(f"USDC-Guthaben ({self.usdc_balance():.2f}) zu gering")
        if self.sol_balance() < self.sc.sol_reserve:
            raise InsufficientFunds(f"SOL-Reserve für Gebühren unterschritten (< {self.sc.sol_reserve})")
        sol, price, fee = self._swap("buy", int(spend * 10 ** USDC_DECIMALS), ref_price)
        return Fill(price, sol, fee, order_id=f"jup-{uuid.uuid4().hex[:8]}")

    def close_long(self, pos: Position, ref_price: float) -> Fill:
        sellable = min(pos.amount, self.sol_balance() - self.sc.sol_reserve)
        raw = math.floor(sellable * 10 ** SOL_DECIMALS)
        if raw <= 0:
            raise InsufficientFunds("Keine verkaufbare SOL-Menge in der Wallet")
        sol, price, fee = self._swap("sell", raw, ref_price)
        return Fill(price, sol, fee, order_id=f"jup-{uuid.uuid4().hex[:8]}")

    def check_stop(self, pos: Position, low_since_entry: float, last_price: float) -> Optional[Fill]:
        """Bot-seitiger Stop: Kurs hat den Stop erreicht -> sofort per Swap verkaufen."""
        if low_since_entry > pos.stop:
            return None
        log.warning("Stop %.4f erreicht (Tief %.4f) – verkaufe %s per Jupiter", pos.stop, low_since_entry, pos.symbol)
        return self.close_long(pos, last_price)
