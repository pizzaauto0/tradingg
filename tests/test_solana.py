import pytest

from tradingbot.config import Config, ConfigError
from tradingbot.execution import Position
from tradingbot.solana_broker import SolanaBroker, load_keypair


class FakeKP:
    def pubkey(self): return "OWNER"


class FakeWorld:
    """Simuliert RPC + Jupiter; Wallet-Salden ändern sich bei jedem Swap."""
    def __init__(self, price=100.0):
        self.sol, self.usdc, self.price, self.swaps = 1.0, 500.0, price, []

    def get(self, url, params=None, timeout=None):
        a = int(params["amount"])
        if params["inputMint"].startswith("EPj"):                 # Kauf: USDC -> SOL
            usdc = a / 1e6; out = int(usdc / self.price * 1e9)
            q = {"inAmount": str(a), "outAmount": str(out), "priceImpactPct": "0.0005", "side": "buy"}
        else:                                                     # Verkauf: SOL -> USDC
            out = int(a / 1e9 * self.price * 1e6)
            q = {"inAmount": str(a), "outAmount": str(out), "priceImpactPct": "0.0005", "side": "sell"}
        return Resp(q)

    def post(self, url, json=None, timeout=None):
        if "quoteResponse" in json:
            return Resp({"swapTransaction": json["quoteResponse"]})
        m, p = json["method"], json["params"]
        if m == "getBalance": return Resp({"result": {"value": int(self.sol * 1e9)}})
        if m == "getTokenAccountsByOwner":
            return Resp({"result": {"value": [{"account": {"data": {"parsed": {"info": {"tokenAmount": {"uiAmount": self.usdc}}}}}}]}})
        if m == "getSignatureStatuses": return Resp({"result": {"value": [{"err": None, "confirmationStatus": "confirmed"}]}})
        raise AssertionError(m)


class Resp:
    def __init__(self, body): self.body = body
    def raise_for_status(self): pass
    def json(self): return self.body


class FakeBroker(SolanaBroker):
    def _sign_and_send(self, quote):                              # statt echter Signatur: Salden anwenden
        a_in, a_out = int(quote["inAmount"]), int(quote["outAmount"])
        fee = (5000 + self.sc.priority_fee_lamports) / 1e9
        if quote["side"] == "buy":
            self.usdc -= a_in / 1e6; self.sol += a_out / 1e9 - fee
        else:
            self.sol -= a_in / 1e9 + fee; self.usdc += a_out / 1e6
        self.http.swaps.append(quote["side"])
        return "SIG"

    @property
    def world(self): return self.http

    def __getattr__(self, name):
        if name in ("sol", "usdc"):
            return getattr(self.http, name)
        raise AttributeError(name)

    def __setattr__(self, name, value):
        if name in ("sol", "usdc"):
            setattr(self.http, name, value)
        else:
            super().__setattr__(name, value)


@pytest.fixture
def broker():
    cfg = Config(broker="solana")
    cfg.market.symbols = ["SOL/USD"]
    return FakeBroker(cfg.validate(), session=FakeWorld(), keypair=FakeKP())


def test_buy_fill_from_wallet_balances(broker):
    fill = broker.open_long("SOL/USD", 2.0, 95.0, 100.0)
    assert fill.amount == pytest.approx(2.0, rel=0.01)
    assert fill.price == pytest.approx(100.0, rel=0.01)
    assert broker.usdc < 500 and broker.sol > 2.9


def test_stop_triggers_sell_and_respects_reserve(broker):
    broker.open_long("SOL/USD", 2.0, 95.0, 100.0)
    pos = Position("SOL/USD", 2.0, 100.0, 95.0, 110.0, 0.1, "2025-01-01T00:00:00+00:00")
    assert broker.check_stop(pos, 96.0, 97.0) is None            # Stop nicht erreicht
    broker.http.price = 94.0
    fill = broker.check_stop(pos, 94.5, 94.0)
    assert fill is not None and fill.price == pytest.approx(94.0, rel=0.01)
    assert broker.sol >= broker.sc.sol_reserve                   # Gebühren-Reserve bleibt


def test_price_deviation_guard_blocks_bad_quote(broker):
    broker.http.price = 130.0                                    # Referenz 100 -> 30 % Abweichung
    with pytest.raises(RuntimeError, match="weicht"):
        broker.open_long("SOL/USD", 1.0, 95.0, 100.0)
    assert broker.http.swaps == []


def test_config_rules(monkeypatch):
    with pytest.raises(ConfigError):
        c = Config(broker="solana"); c.market.symbols = ["BTC/USD"]; c.validate()
    monkeypatch.delenv("SOLANA_PRIVATE_KEY", raising=False)
    c = Config(broker="solana"); c.market.symbols = ["SOL/USD"]
    with pytest.raises(ConfigError):
        c.live_credentials()


def test_load_keypair_formats():
    from solders.keypair import Keypair
    k = Keypair()
    assert str(load_keypair(str(k)).pubkey()) == str(k.pubkey())
    assert str(load_keypair(str(list(bytes(k)))).pubkey()) == str(k.pubkey())


def test_keyring_fallback(monkeypatch):
    from solders.keypair import Keypair
    import tradingbot.solana_broker as sb
    k = Keypair()
    monkeypatch.delenv("SOLANA_PRIVATE_KEY", raising=False)
    monkeypatch.setattr(sb, "keyring_get", lambda: str(k))
    cfg = Config(broker="solana"); cfg.market.symbols = ["SOL/USD"]
    assert sb.SolanaBroker(cfg.validate(), session=object()).owner == str(k.pubkey())
    assert cfg.live_credentials()[0] == str(k)
