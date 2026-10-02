# Stocks setup

The Stocks widget shows a watchlist of tickers with prices, the day's change, a 30-day trend line, and a chart
for each ticker (1 day, 5 days, 1 month, 6 months, 1 year, 5 years; drag a finger across it to read a price).
Price alerts ring through the notification bell with a sound on every screen, whichever page is showing.

Everything is set on the touchscreen:

- **✎** edits the watchlist (add a ticker like `AAPL`, reorder, remove). Up to 20 tickers.
- Tap a ticker for its chart and alerts, then **＋ Alert**: price above, price below, or a move of some percent
  up or down from yesterday's close. An alert fires once and switches off, or once every trading day.
- **🔔** lists every alert with an on/off switch. **⚙** picks the sound, volume, how many times it plays,
  how often prices refresh, and has **Test alert**.
- A tile's own ⚙ (in edit mode) can limit it to some tickers (`TSLA` on a small tile shows just Tesla) and
  pick its default chart range. The widget also fits in the top bar, cycling through the tickers.

The Pi checks prices itself, so alerts work with no Stocks tile on screen. It polls every couple of minutes
while the US market is open (9:30 to 4:00 New York time, weekdays) and every few hours otherwise.

## Data source

It works straight away with **Yahoo Finance** (no account), which is free but unofficial: Yahoo can change it or
throttle it without notice. For a sturdier feed, add a free **Twelve Data** key:

1. Sign up at [twelvedata.com](https://twelvedata.com) (the free Basic plan, no card).
2. Copy your key from **API Keys** in the dashboard ([twelvedata.com/account/api-keys](https://twelvedata.com/account/api-keys)).
3. From the laptop, in the pidisplay folder:

```powershell
.\deploy\stocks.ps1 -Key abcd1234...      # save it; prints the data source and a fresh price for each ticker
.\deploy\stocks.ps1                        # check status any time
.\deploy\stocks.ps1 -RemoveKey             # back to Yahoo
```

The key is stored only on the Pi in `~/pidisplay-data/stocks-key.json` (mode 600), never in git or the browser.
No restart is needed.

Twelve Data's free plan allows 8 requests a minute and 800 a day, one per ticker. The Pi keeps count and slows
its refresh to fit: with 5 tickers it refreshes about every 4 minutes during market hours, with 10 about every
7. Daily history is saved on the Pi (`~/pidisplay-data/stocks-history.json`) and kept up to date from the live
prices, so it costs one request per ticker when the ticker is added and none after a restart; the source is only
asked again to fill a gap, such as after the Pi was off for a few days. The 1D and 5D charts cost one request
each when opened (at most every 5 minutes).
**⚙** on the tile shows how many have been used today.

### Free options compared (October 2026)

| Service | Free limit | Live prices | History | Key |
| --- | --- | --- | --- | --- |
| Twelve Data | 8/min, 800/day | Real-time US stocks | Daily back decades, intraday | Yes, free |
| Finnhub | 60/min | Real-time US quotes | Price history (candles) is paid only | Yes, free |
| Alpha Vantage | 25/day | 15-min delayed | Daily | Yes, free |
| Tiingo | 50/hour, 1,000/day | IEX real-time | 30+ years daily | Yes, free |
| Yahoo Finance | Unofficial, unpublished | Real-time | Everything | No |

Twelve Data was picked because one free key covers live prices, intraday charts and 5-year history within
limits that fit a small watchlist polled every few minutes. Finnhub's free tier has no history, Alpha Vantage's
25 a day is too few, and Tiingo's 50 an hour can't poll a watchlist every few minutes.

## Tickers

US stocks and ETFs by ticker (`AAPL`, `SPY`). With Yahoo, indexes start with `^` (`^GSPC` for the S&P 500)
and crypto is `BTC-USD`; with Twelve Data, other exchanges are `SHOP:TSX` and crypto is `BTC/USD`. A ticker the
source doesn't know shows a warning on its row and in `stocks.ps1`.
