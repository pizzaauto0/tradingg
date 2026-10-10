"""Typisierte Konfiguration aus config.yaml (unbekannte Schlüssel werden abgelehnt)."""
from __future__ import annotations

import dataclasses
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, get_type_hints

import yaml

from .util import timeframe_seconds


class ConfigError(ValueError):
    pass


@dataclass
class ExchangeCfg:
    id: str = "kraken"
    api_key_env: str = "EXCHANGE_API_KEY"
    api_secret_env: str = "EXCHANGE_API_SECRET"


@dataclass
class SolanaCfg:
    rpc_url: str = "https://api.mainnet-beta.solana.com"
    private_key_env: str = "SOLANA_PRIVATE_KEY"
    jupiter_url: str = "https://lite-api.jup.ag/swap/v1"
    usdc_mint: str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    sol_reserve: float = 0.05
    slippage_bps: int = 50
    max_price_impact_pct: float = 0.5
    max_deviation_pct: float = 1.0
    priority_fee_lamports: int = 50000


@dataclass
class IbkrCfg:
    """Interactive Brokers (Forex). TWS oder IB Gateway muss laufen und eingeloggt sein."""
    host: str = "127.0.0.1"
    port: int = 4002                      # IB Gateway: 4002 Paper / 4001 Live; TWS: 7497 Paper / 7496 Live
    client_id: int = 17
    account: str = ""                     # leer = erstes Konto der Anmeldung
    account_type: str = "paper"           # paper | live – bei "paper" verweigert der Bot echte Konten (nicht "DU…")


@dataclass
class MarketCfg:
    symbols: list[str] = field(default_factory=lambda: ["BTC/USD", "ETH/USD"])
    timeframe: str = "15m"
    history_candles: int = 3000
    history_exchange: str = ""
    live_lookback: int = 300
    poll_seconds: int = 20
    allow_short: bool = False             # Leerverkäufe (nur broker: ibkr / Forex)


@dataclass
class CapitalCfg:
    start: float = 1000.0


@dataclass
class RiskCfg:
    risk_per_trade_pct: float = 1.0
    max_daily_loss_pct: float = 5.0
    close_positions_on_daily_limit: bool = True
    max_open_positions: int = 2
    max_position_pct: float = 50.0
    atr_period: int = 14
    atr_stop_mult: float = 2.0
    take_profit_rr: float = 2.0
    kill_switch_file: str = "KILL_SWITCH"


@dataclass
class CostsCfg:
    fee_pct: float = 0.26
    slippage_pct: float = 0.05


@dataclass
class BacktestCfg:
    min_candles: int = 1000
    min_trades: int = 20
    min_return_pct: float = 2.0
    max_drawdown_pct: float = 15.0
    min_sharpe: float = 1.0
    min_win_rate_pct: float = 55.0
    min_profit_factor: float = 1.2
    oos_fraction: float = 0.3
    min_oos_return_pct: float = 0.0


@dataclass
class PipelineCfg:
    revalidate_hours: float = 24.0
    max_active_strategies: int = 5        # nur die besten N zugelassenen Strategien handeln aktiv


@dataclass
class LlmCfg:
    enabled: bool = False
    model: str = "claude-sonnet-5-5"
    api_key_env: str = "ANTHROPIC_API_KEY"
    max_tokens: int = 4000


@dataclass
class TelegramCfg:
    enabled: bool = False
    token_env: str = "TELEGRAM_BOT_TOKEN"
    chat_id_env: str = "TELEGRAM_CHAT_ID"


@dataclass
class PathsCfg:
    data_dir: str = "data"


@dataclass
class Config:
    live_trading: bool = False
    broker: str = "ccxt"                  # ccxt (Krypto-Börse) | solana (Wallet über Jupiter) | ibkr (Forex)
    exchange: ExchangeCfg = field(default_factory=ExchangeCfg)
    solana: SolanaCfg = field(default_factory=SolanaCfg)
    ibkr: IbkrCfg = field(default_factory=IbkrCfg)
    market: MarketCfg = field(default_factory=MarketCfg)
    capital: CapitalCfg = field(default_factory=CapitalCfg)
    risk: RiskCfg = field(default_factory=RiskCfg)
    costs: CostsCfg = field(default_factory=CostsCfg)
    backtest: BacktestCfg = field(default_factory=BacktestCfg)
    pipeline: PipelineCfg = field(default_factory=PipelineCfg)
    llm: LlmCfg = field(default_factory=LlmCfg)
    telegram: TelegramCfg = field(default_factory=TelegramCfg)
    paths: PathsCfg = field(default_factory=PathsCfg)

    # ----- abgeleitete Werte -----
    @property
    def mode(self) -> str:
        return "live" if self.live_trading else "paper"

    @property
    def is_margin(self) -> bool:
        """Margin-Konto (Forex über IBKR): Long und Short, Gewinn/Verlust statt Kauf mit Bargeld."""
        return self.broker == "ibkr"

    @property
    def quote(self) -> str:
        return self.market.symbols[0].split("/")[1]

    @property
    def timeframe_seconds(self) -> int:
        return timeframe_seconds(self.market.timeframe)

    @property
    def data_dir(self) -> Path:
        return Path(self.paths.data_dir)

    def live_credentials(self) -> tuple[str, str]:
        if self.broker == "ibkr":
            return "", ""  # Anmeldung erfolgt in TWS / IB Gateway, nicht über den Bot
        if self.broker == "solana":
            from .solana_broker import keyring_get

            key = os.environ.get(self.solana.private_key_env, "") or keyring_get()
            if not key:
                raise ConfigError(f"Live-Modus (solana) benötigt den Schlüssel: Umgebungsvariable "
                                  f"{self.solana.private_key_env} oder 'python main.py set-key'.")
            return key, ""
        key = os.environ.get(self.exchange.api_key_env, "")
        secret = os.environ.get(self.exchange.api_secret_env, "")
        if not key or not secret:
            raise ConfigError(
                f"Live-Modus benötigt die Umgebungsvariablen {self.exchange.api_key_env} "
                f"und {self.exchange.api_secret_env}."
            )
        return key, secret

    def validate(self) -> "Config":
        e = ConfigError
        if not isinstance(self.live_trading, bool):
            raise e("live_trading muss true oder false sein.")
        if self.broker not in ("ccxt", "solana", "ibkr"):
            raise e("broker muss 'ccxt', 'solana' oder 'ibkr' sein.")
        if self.market.allow_short and not self.is_margin:
            raise e("market.allow_short ist nur mit broker 'ibkr' (Forex) möglich – Spot-Krypto wird nur gekauft.")
        if self.broker == "ibkr":
            if any(len(p) != 3 or not p.isalpha() for sym in self.market.symbols for p in sym.split("/")):
                raise e("broker 'ibkr': Symbole als Währungspaare angeben, z. B. EUR/USD.")
            if self.ibkr.account_type not in ("paper", "live"):
                raise e("ibkr.account_type muss 'paper' oder 'live' sein.")
        if self.pipeline.max_active_strategies < 1:
            raise e("pipeline.max_active_strategies muss >= 1 sein.")
        if not self.market.symbols:
            raise e("market.symbols darf nicht leer sein.")
        if self.broker == "solana" and any(sym.split("/")[0] != "SOL" for sym in self.market.symbols):
            raise e("broker 'solana' unterstützt derzeit nur SOL-Symbole (z. B. SOL/USD).")
        if self.solana.sol_reserve < 0 or self.solana.slippage_bps < 1:
            raise e("solana.sol_reserve >= 0 und slippage_bps >= 1 erforderlich.")
        quotes = set()
        for s in self.market.symbols:
            if s.count("/") != 1 or not all(s.split("/")):
                raise e(f"Ungültiges Symbol {s!r} (erwartet z. B. BTC/USD).")
            quotes.add(s.split("/")[1])
        if len(quotes) != 1:
            raise e("Alle Symbole müssen dieselbe Quote-Währung haben.")
        timeframe_seconds(self.market.timeframe)
        if self.market.poll_seconds < 1 or self.market.live_lookback < 150:
            raise e("poll_seconds >= 1 und live_lookback >= 150 erforderlich.")
        if self.capital.start <= 0:
            raise e("capital.start muss > 0 sein.")
        r = self.risk
        if not 0 < r.risk_per_trade_pct <= 2:
            raise e("risk.risk_per_trade_pct muss in (0, 2] liegen.")
        if not 0 < r.max_daily_loss_pct <= 100:
            raise e("risk.max_daily_loss_pct muss in (0, 100] liegen.")
        if r.max_open_positions < 1:
            raise e("risk.max_open_positions muss >= 1 sein.")
        max_pos = 3000 if self.is_margin else 100  # Forex: Hebel bis 30:1 (ESMA-Grenze für Majors), sonst kein Hebel
        if not 0 < r.max_position_pct <= max_pos:
            raise e(f"risk.max_position_pct muss in (0, {max_pos}] liegen.")
        if r.atr_period < 2 or r.atr_stop_mult <= 0 or r.take_profit_rr <= 0:
            raise e("risk.atr_period >= 2, atr_stop_mult > 0 und take_profit_rr > 0 erforderlich.")
        if self.costs.fee_pct < 0 or self.costs.slippage_pct < 0:
            raise e("costs.* dürfen nicht negativ sein.")
        if not 0 < self.backtest.oos_fraction < 1:
            raise e("backtest.oos_fraction muss in (0, 1) liegen.")
        if self.pipeline.revalidate_hours <= 0:
            raise e("pipeline.revalidate_hours muss > 0 sein.")
        return self


def _from_dict(cls: type, data: dict[str, Any], path: str = "") -> Any:
    hints = get_type_hints(cls)
    unknown = set(data) - set(hints)
    if unknown:
        raise ConfigError(f"Unbekannte Konfig-Schlüssel in '{path or 'root'}': {sorted(unknown)}")
    kwargs: dict[str, Any] = {}
    for key, value in data.items():
        hint = hints[key]
        if dataclasses.is_dataclass(hint):
            if value is None:
                value = {}
            if not isinstance(value, dict):
                raise ConfigError(f"'{path}{key}' muss ein Abschnitt (Mapping) sein.")
            kwargs[key] = _from_dict(hint, value, f"{path}{key}.")
        else:
            kwargs[key] = value
    return cls(**kwargs)


def load_config(path: str | Path = "config.yaml") -> Config:
    path = Path(path)
    if not path.exists():
        raise ConfigError(f"Konfigurationsdatei nicht gefunden: {path}")
    with open(path, encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    if not isinstance(raw, dict):
        raise ConfigError("config.yaml muss ein Mapping enthalten.")
    return _from_dict(Config, raw).validate()
