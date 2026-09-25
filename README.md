# Tradeapp

Tradeapp is a private personal-finance app for a small group of about 5–10 trusted users. It combines investment performance, spending, and total net worth in one place.

The primary purpose is net-worth and investment tracking. Spending analysis is secondary. Tradeapp is a household-finance tracker, not a trading platform, bank, broker, or public SaaS product.

The app is currently in early development.

## Product goals

Tradeapp should answer these questions for each signed-in user:

- What is my total net worth?
- What accounts and assets make up that net worth?
- How are my stocks, bonds, and overall portfolio performing?
- What did I spend this month, and where did the money go?
- What salary or other income came in?

The interface should feel like Intuit Mint: a calm household-finance dashboard, not a day-trading terminal.

## How it works

1. **SnapTrade** connects users' brokerage and investment accounts through its read-only Connection Portal.
2. **Plaid** connects checking, savings, credit-card, loan, and other non-brokerage financial accounts.
3. **Supabase** stores users, SnapTrade user credentials, connected accounts, transactions, holdings, and historical balance and asset snapshots.
4. **Vercel Cron Jobs** run a daily SnapTrade refresh for every user and save the latest asset and account values.
5. **Live market data** updates stock and bond prices throughout the day so investment values can move between daily SnapTrade snapshots.
6. Tradeapp combines account balances, holdings, and market prices into portfolio and net-worth views.

The app reads financial data but does not place trades or move money.

Development and preview deployments set `SNAPTRADE_BROKER=SANDBOX` so their connection portal opens SnapTrade's simulated brokerage. Production leaves that variable unset and uses separate production credentials so users can choose real brokerages.

## Platform and access

Vercel provides staging and production deployment. The production app is intended to be available at [https://trade2app.vercel.app/](https://trade2app.vercel.app/).

Tradeapp is a mobile-first web app designed for:

- iPhone and other iOS devices
- Android devices, with particular attention to the Pixel Fold
- Desktop web browsers

The intended phone experience is an installable web app that users add to their home screen and open like a native app. Web and mobile should share one product model rather than separate feature sets.

## Feature priorities

### Core

- Total net worth across all connected accounts
- Investment holdings and portfolio performance
- Daily SnapTrade asset and balance snapshots
- Intraday stock and bond price updates
- Spending tracking with expense categories
- Income tracking

### Nice to have

These features would be useful but are not required for the initial version:

- Credit-card points tracking
- Credit-card statement-credit and benefit tracking
- A points-redemption search API similar to [Seats.aero](https://seats.aero/)

## Security and scope

Balances, transactions, holdings, user details, and provider credentials are sensitive. Never log Plaid access tokens, SnapTrade consumer keys or per-user secrets, service-role keys, raw account data, or other secrets.

Design for a handful of trusted users. Public sign-up, marketplace billing, large-scale multi-tenancy, financial advice, and trade execution are out of scope.

## Technology

- Next.js and React
- Vercel deployments and cron jobs
- SnapTrade for read-only brokerage-account connections
- Plaid for non-brokerage financial-account connections
- Supabase and Postgres for application data

## Local development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Other useful commands:

```bash
npm run lint
npm run build
npm run check:env
```
