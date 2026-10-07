# ServiceRouter

Requires Node.js 24+, npm, and Docker Compose.

## Run locally

```sh
npm ci
cp .env.example .env
node scripts/secrets-keygen.mjs
```

Add the generated keys to `SECRETS_PUBLIC_KEY` and `SECRETS_PRIVATE_KEYS` in `.env`, writing PEM newlines as literal `\n`. Replace the placeholder shared secrets.

For local use without payment providers, set `enabled: false` on each facilitator, `mpp`, and `deposits` in [config/example.yaml](config/example.yaml).

```sh
docker compose up -d
npm run db:migrate
npm run dev
```

Open the website at [localhost:3000](http://localhost:3000). The API runs on port 8081 and the payment proxy on port 8080.

See the [architecture docs](docs/architecture/README.md).
