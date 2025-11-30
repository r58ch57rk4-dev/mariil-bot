# Mari-Il Agency Bot Server

Backend service for **@MariIlAgencyBot**.

## What it does
- Receives Telegram updates via webhook
- Works as a sales bot: segmentation + short brief + lead capture
- Sends new leads to the owner in Telegram
- Saves leads to Supabase (Postgres)
- Receives leads from the website (API endpoint)

## Tech stack
Node.js + Express + Telegraf + Supabase

## Environment variables
Set these in your hosting provider (Railway/Render). Do not commit them to GitHub.

- BOT_TOKEN
- ADMIN_CHAT_ID
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- WEBHOOK_SECRET
- SITE_ORIGIN

## Endpoints
- POST /telegram/webhook
- POST /api/lead

 mariil-bot
