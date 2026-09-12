# Tradeapp

A private personal-finance app for a small group (about 5–10 people). Users link bank and brokerage accounts with Plaid and see spending, pay, investments, and net worth in one place.

This is a household-finance tracker, not a trading platform and not a product for the public.

## Purpose

Answer, for each signed-in user:

- What did I spend so far this month?
- What salary or other income came in?
- How are my stocks doing?
- What does my portfolio look like?
- What is my total net worth?

The UI should feel like Intuit Mint: a calm dashboard of accounts, cash flow, and net worth. It should not look like a day-trading terminal.

## Who it is for

A handful of trusted users. Do not design for viral growth, org-wide multi-tenancy, or marketplace billing. Keep the account model simple enough for 5–10 people.

## Platforms

| Surface | Status |
| --- | --- |
| Web | Primary |
| Android (including Pixel) | Required |
| iOS | Required |

Share one product model across web and mobile. Do not split features by platform unless a platform API forces it.

## Account linking

Plaid is how users connect:

- Everyday finance accounts (checking, savings, cards, and similar)
- Stock / brokerage accounts

The app reads linked data to classify and display transactions, income, holdings, and balances. It does not need to place trades.

Treat balances, transactions, holdings, and Plaid credentials as sensitive. Do not log access tokens or secrets.

## Hosting and access (TBD)

Not decided yet:

- Where the app is hosted
- How clients reach it (public HTTPS, private VPN, or something else)

Do not treat a host or network path as a given until that decision is written down here.

## Out of scope (for now)

- Public sign-up or an app-store audience beyond this small group
- Acting as a bank, advisor, or broker
- Deciding hosting, VPN, or HTTP access before that work is chosen
