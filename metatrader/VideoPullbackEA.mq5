//+------------------------------------------------------------------+
//| VideoPullbackEA.mq5                                              |
//| Trend-Pullback an der Durchschnittslinie (Methode aus dem Video) |
//|                                                                  |
//| Frage 1: Steigt die lange Linie (Trend ueber Wochen nach oben)?  |
//| Frage 2: Fiel der Kurs bis an die Linie zurueck und schliesst    |
//|          die Kerze wieder darueber (bullisch)?  -> KAUFEN        |
//| Stop-Loss = ATR * Faktor, Ziel = Vielfaches des Risikos (2:1).   |
//| Optional Short (spiegelbildlich), standardmaessig AUS.           |
//|                                                                  |
//| WICHTIG: Nicht kompiliert/getestet in dieser Entwicklungsumgebung|
//| (kein MetaEditor). Erst kompilieren, dann im Strategietester und |
//| auf einem DEMO-Konto laufen lassen. Keine Gewinngarantie.        |
//+------------------------------------------------------------------+
#property copyright "Trading-Bot-Projekt"
#property version   "1.00"
#property strict

#include <Trade\Trade.mqh>

input group "Strategie"
input int    MAPeriod        = 100;    // Lange Durchschnittslinie (SMA), z. B. 100 oder 200 auf D1/H4
input int    SlopeBars       = 20;     // Linie muss hoeher sein als vor N Kerzen (Trend ueber Wochen)
input double TouchPercent    = 0.5;    // Kerzentief darf hoechstens X % ueber der Linie liegen
input double ExitPercent     = 3.0;    // Ausstieg, wenn Schlusskurs X % unter der Linie (Trend gebrochen)
input bool   AllowShort      = false;  // Leerverkaeufe (Spiegelbild) erlauben

input group "Risiko"
input double RiskPercent     = 1.0;    // Risiko je Trade in % des Kontos (max. 2 erlaubt)
input int    ATRPeriod       = 14;
input double ATRStopMult     = 2.0;    // Stop-Loss = ATR * Faktor
input double RewardRisk      = 2.0;    // Ziel = Faktor * Risiko (2 = doppelt so weit wie der Stop)
input double MaxDailyLossPct = 5.0;    // Tagesverlust-Limit in % (danach kein neuer Trade bis morgen)
input int    MaxOpenTrades   = 1;      // Maximal offene Positionen dieses EAs
input int    MaxSpreadPoints = 0;      // 0 = ungeprueft; sonst kein Einstieg bei groesserem Spread
input int    SlippagePoints  = 30;

input group "Sicherheit"
input bool   TradingEnabled  = true;   // Not-Aus: false = keine neuen Trades (offene bleiben mit Stop)
input bool   AllowLiveAccount= false;  // Standard: handelt NUR auf Demo-Konten
input ulong  MagicNumber     = 20250101;
input string TradeComment    = "VideoPullback";

CTrade   trade;
int      hMA = INVALID_HANDLE, hATR = INVALID_HANDLE;
datetime lastBarTime = 0;
string   statusText = "";

//+------------------------------------------------------------------+
int OnInit()
{
   if(MAPeriod < 20 || SlopeBars < 5 || RiskPercent <= 0 || RiskPercent > 2.0 || RewardRisk < 0.5 || ATRStopMult < 0.5)
   {
      Print("Ungueltige Eingaben (Risiko 0-2 %, MA >= 20, Steigung >= 5, Ziel >= 0.5R, ATR-Faktor >= 0.5).");
      return INIT_PARAMETERS_INCORRECT;
   }
   if(AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_REAL && !AllowLiveAccount)
   {
      Print("ECHTES Konto erkannt: Der EA handelt nur auf Demo-Konten. Zum Freischalten AllowLiveAccount=true setzen (auf eigenes Risiko).");
      return INIT_FAILED;
   }
   hMA  = iMA(_Symbol, _Period, MAPeriod, 0, MODE_SMA, PRICE_CLOSE);
   hATR = iATR(_Symbol, _Period, ATRPeriod);
   if(hMA == INVALID_HANDLE || hATR == INVALID_HANDLE)
   {
      Print("Indikatoren konnten nicht erstellt werden.");
      return INIT_FAILED;
   }
   ChartIndicatorAdd(0, 0, hMA); // Linie im Chart anzeigen
   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(SlippagePoints);
   trade.SetTypeFillingBySymbol(_Symbol);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   if(hMA  != INVALID_HANDLE) IndicatorRelease(hMA);
   if(hATR != INVALID_HANDLE) IndicatorRelease(hATR);
   Comment("");
}

//+------------------------------------------------------------------+
int CountOwnPositions(long &type)
{
   int n = 0; type = -1;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong t = PositionGetTicket(i);
      if(t == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
      if((ulong)PositionGetInteger(POSITION_MAGIC) != MagicNumber) continue;
      n++; type = PositionGetInteger(POSITION_TYPE);
   }
   return n;
}

void CloseOwnPositions(const string why)
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong t = PositionGetTicket(i);
      if(t == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
      if((ulong)PositionGetInteger(POSITION_MAGIC) != MagicNumber) continue;
      if(trade.PositionClose(t)) PrintFormat("Position %I64u geschlossen: %s", t, why);
   }
}

// Gewinn/Verlust des heutigen Tages (geschlossene Trades dieses EAs + offene Positionen)
double TodayPnL()
{
   MqlDateTime d; TimeToStruct(TimeCurrent(), d);
   d.hour = 0; d.min = 0; d.sec = 0;
   datetime from = StructToTime(d), to = TimeCurrent() + 60;
   double pnl = 0.0;
   if(HistorySelect(from, to))
   {
      for(int i = HistoryDealsTotal() - 1; i >= 0; i--)
      {
         ulong tk = HistoryDealGetTicket(i);
         if(tk == 0) continue;
         if((ulong)HistoryDealGetInteger(tk, DEAL_MAGIC) != MagicNumber) continue;
         if(HistoryDealGetString(tk, DEAL_SYMBOL) != _Symbol) continue;
         if(HistoryDealGetInteger(tk, DEAL_ENTRY) != DEAL_ENTRY_OUT) continue;
         pnl += HistoryDealGetDouble(tk, DEAL_PROFIT) + HistoryDealGetDouble(tk, DEAL_SWAP) + HistoryDealGetDouble(tk, DEAL_COMMISSION);
      }
   }
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong t = PositionGetTicket(i);
      if(t == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
      if((ulong)PositionGetInteger(POSITION_MAGIC) != MagicNumber) continue;
      pnl += PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP);
   }
   return pnl;
}

// Lotgroesse so, dass der Verlust beim Stop ca. RiskPercent % des Kontos betraegt
double LotsForRisk(const double slDistance)
{
   double tickSize  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE_LOSS);
   if(tickValue <= 0) tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   if(tickSize <= 0 || tickValue <= 0 || slDistance <= 0) return 0.0;
   double riskMoney   = AccountInfoDouble(ACCOUNT_EQUITY) * RiskPercent / 100.0;
   double lossPerLot  = slDistance / tickSize * tickValue;
   double lots        = riskMoney / lossPerLot;
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double vmin = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double vmax = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   if(step <= 0) return 0.0;
   lots = MathFloor(lots / step) * step;
   if(lots < vmin) return 0.0;               // Mindestlot waere zu riskant -> kein Trade
   return MathMin(lots, vmax);
}

void Mark(const string name, const datetime t, const double price, const int arrowCode, const color clr)
{
   if(ObjectFind(0, name) >= 0) return;
   ObjectCreate(0, name, OBJ_ARROW, 0, t, price);
   ObjectSetInteger(0, name, OBJPROP_ARROWCODE, arrowCode);
   ObjectSetInteger(0, name, OBJPROP_COLOR, clr);
}

//+------------------------------------------------------------------+
void OnTick()
{
   // Nur einmal pro neuer Kerze entscheiden (auf Basis der geschlossenen Kerze 1)
   datetime barTime = iTime(_Symbol, _Period, 0);
   if(barTime == lastBarTime) return;
   lastBarTime = barTime;

   int need = MAPeriod + SlopeBars + 5;
   if(Bars(_Symbol, _Period) < need) { Comment("Zu wenige Kerzen"); return; }

   double ma[], atr[];
   ArraySetAsSeries(ma, true); ArraySetAsSeries(atr, true);
   if(CopyBuffer(hMA, 0, 0, SlopeBars + 3, ma) < SlopeBars + 2) return;
   if(CopyBuffer(hATR, 0, 0, 3, atr) < 2) return;
   double open1 = iOpen(_Symbol, _Period, 1), close1 = iClose(_Symbol, _Period, 1);
   double high1 = iHigh(_Symbol, _Period, 1), low1  = iLow(_Symbol, _Period, 1);
   double ma1 = ma[1], maOld = ma[1 + SlopeBars], atr1 = atr[1];

   bool rising  = ma1 > maOld;                                   // Frage 1 (Long)
   bool falling = ma1 < maOld;                                   // Frage 1 (Short)
   bool pullLong  = low1  <= ma1 * (1.0 + TouchPercent / 100.0) && close1 > ma1 && close1 > open1;   // Frage 2 (Long)
   bool pullShort = high1 >= ma1 * (1.0 - TouchPercent / 100.0) && close1 < ma1 && close1 < open1;  // Frage 2 (Short)
   bool buySignal  = rising  && pullLong;
   bool sellSignal = AllowShort && falling && pullShort;

   long ptype; int open = CountOwnPositions(ptype);

   // Ausstieg: Trend gebrochen
   if(open > 0)
   {
      if(ptype == POSITION_TYPE_BUY  && close1 < ma1 * (1.0 - ExitPercent / 100.0)) CloseOwnPositions("Trend gebrochen (Long)");
      if(ptype == POSITION_TYPE_SELL && close1 > ma1 * (1.0 + ExitPercent / 100.0)) CloseOwnPositions("Trend gebrochen (Short)");
      open = CountOwnPositions(ptype);
   }

   double dailyPnL = TodayPnL();
   double limit = -AccountInfoDouble(ACCOUNT_EQUITY) * MaxDailyLossPct / 100.0;
   bool dailyHalt = dailyPnL <= limit;

   statusText = StringFormat("Trend steigt: %s | Rücksetzer an Linie: %s | Signal: %s | offen: %d | Tages-PnL: %.2f%s",
                             rising ? "JA" : "nein", pullLong ? "JA" : "nein",
                             buySignal ? "KAUFEN" : (sellSignal ? "VERKAUFEN" : "keins"), open, dailyPnL,
                             dailyHalt ? " | TAGESLIMIT AKTIV" : "");
   Comment("VideoPullbackEA  ", _Symbol, " ", EnumToString(_Period), "\n", statusText);

   if(!TradingEnabled || dailyHalt) return;
   if(open >= MaxOpenTrades) return;
   if(!buySignal && !sellSignal) return;
   if(MaxSpreadPoints > 0 && SymbolInfoInteger(_Symbol, SYMBOL_SPREAD) > MaxSpreadPoints) { Print("Spread zu gross, kein Einstieg."); return; }

   double slDist = atr1 * ATRStopMult;
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK), bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   long   stopsLevel = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL);
   double minDist = stopsLevel * _Point;
   if(slDist < minDist) slDist = minDist;
   double lots = LotsForRisk(slDist);
   if(lots <= 0) { Print("Positionsgroesse nicht moeglich (Konto zu klein fuer das Risiko).");  return; }

   if(buySignal)
   {
      double sl = NormalizeDouble(ask - slDist, _Digits), tp = NormalizeDouble(ask + slDist * RewardRisk, _Digits);
      if(trade.Buy(lots, _Symbol, ask, sl, tp, TradeComment))
      {
         PrintFormat("KAUF %.2f Lots @ %.5f, Stop %.5f, Ziel %.5f", lots, ask, sl, tp);
         Mark("kauf_" + (string)barTime, iTime(_Symbol, _Period, 1), low1, 233, clrLime);
      }
      else PrintFormat("Kauf fehlgeschlagen: %d %s", trade.ResultRetcode(), trade.ResultRetcodeDescription());
   }
   else if(sellSignal)
   {
      double sl = NormalizeDouble(bid + slDist, _Digits), tp = NormalizeDouble(bid - slDist * RewardRisk, _Digits);
      if(trade.Sell(lots, _Symbol, bid, sl, tp, TradeComment))
      {
         PrintFormat("VERKAUF %.2f Lots @ %.5f, Stop %.5f, Ziel %.5f", lots, bid, sl, tp);
         Mark("verkauf_" + (string)barTime, iTime(_Symbol, _Period, 1), high1, 234, clrRed);
      }
      else PrintFormat("Verkauf fehlgeschlagen: %d %s", trade.ResultRetcode(), trade.ResultRetcodeDescription());
   }
}
//+------------------------------------------------------------------+
