# 1. Setup: from a blank laptop to a running API

Follow the steps in order. Each step says what to run, what it does and what you should see.
If what you see is different, stop there and ask: later steps depend on earlier ones.

> **Windows:** use WSL 2 (Ubuntu) and run every command inside the Ubuntu terminal, not in
> PowerShell. Our scripts use `sh` and Unix paths. Install
> [WSL](https://learn.microsoft.com/windows/wsl/install) first, then follow the Linux lines.

## Step 1: tools

| Tool                      | Why we need it                                        | Check it works           |
| ------------------------- | ----------------------------------------------------- | ------------------------ |
| Git                       | Version control: every change is a commit             | `git --version`          |
| fnm                       | Installs the exact Node.js version the repo wants     | `fnm --version`          |
| Node.js 26                | Runs JavaScript and TypeScript outside the browser    | `node -v` → `v26.…`      |
| pnpm 12 (via Corepack)    | Installs packages; one install for the whole repo     | `pnpm -v` → `12.16.1`    |
| Docker                    | Runs PostgreSQL, Redis and Mailpit in containers      | `docker run hello-world` |
| VS Code                   | Editor (any editor works, the repo has VS Code hints) | —                        |
| Postman v12 + Postman CLI | Send requests to the API by hand and in tests         | `postman --version`      |

**macOS:**

```sh
brew install git fnm
# Docker: install OrbStack (lighter) or Docker Desktop, then open it once
brew install --cask orbstack
```

**Linux / WSL:**

```sh
sudo apt update && sudo apt install -y git curl unzip
curl -fsSL https://fnm.vercel.app/install | bash
# Docker: on WSL install Docker Desktop for Windows and turn on "WSL integration"
```

**Linux (not WSL):** install [Docker Engine](https://docs.docker.com/engine/install/), then
`sudo usermod -aG docker $USER` and log out and in, so `docker` works without `sudo`.

**Postman (all systems):** install the [Postman app](https://www.postman.com/downloads/) (v12) and
the [Postman CLI](https://learning.postman.com/docs/postman-cli/postman-cli-installation/).

Then make sure fnm loads in each new terminal. Open a new terminal and run `fnm --version`. If it
says "command not found", add this line to your shell file (`~/.zshrc` on macOS, `~/.bashrc` on
Linux) and open a new terminal again:

```sh
eval "$(fnm env --use-on-cd)"
```

Close the terminal and open a new one. `--use-on-cd` means: when you `cd` into a folder with an
`.nvmrc` file, fnm switches to that Node version for you.

## Step 2: get the code

```sh
git config --global user.name "Your Name"
git config --global user.email "you@example.com"   # the email of your GitHub account

git clone https://github.com/Ashfak-Hossain/pulse.git
cd pulse
```

`cd pulse` reads `.nvmrc` (it says `26`). If fnm says Node 26 is not installed:

```sh
fnm install      # installs the version in .nvmrc
node -v          # v26.x.x
```

## Step 3: pnpm through Corepack

Corepack is a small tool that downloads the exact pnpm version written in `package.json`
(`"packageManager": "pnpm@12.16.1+sha512…"`), so everyone uses the same one. Node 26 no longer
ships it, so install it once:

```sh
npm install -g corepack
corepack enable
pnpm -v          # 12.16.1
```

The first `pnpm -v` asks "Corepack is about to download … pnpm. Do you want to continue?": answer
`Y`.

## Step 4: install the packages and build the shared ones

```sh
pnpm install
pnpm build
```

This reads `pnpm-lock.yaml` and installs every package for every app and package in the repo
into `node_modules/`. It also sets up the git hooks (Husky), which check your formatting before
each commit and your commit message after you write it.

You should see it finish with `Done in …`. Warnings about "ignored build scripts" are expected:
we deny install scripts unless a package truly needs one (`pnpm-workspace.yaml`).

`pnpm build` compiles the shared packages (`@pulse/contracts`, `@pulse/db`, `@pulse/money`) into
their `dist/` folders. The API uses those compiled files, so without this step it cannot start
("Cannot find module '…/dist/index.js'").

## Step 5: settings file

```sh
cp .env.example .env
```

`.env` holds settings such as the database address. `.env.example` is committed with safe local
values; `.env` is your own copy and is never committed (git ignores it). You do not need to
change anything in it for local work.

## Step 6: start the services

Make sure Docker (OrbStack / Docker Desktop) is running, then:

```sh
pnpm infra:up      # starts PostgreSQL, Redis, Mailpit and waits until they are healthy
pnpm infra:ps      # every service should say "(healthy)"
```

The first start downloads the images (a few minutes). On Apple Silicon (M1/M2) PostgreSQL runs
under Rosetta, so it is a bit slower; that is expected.

| Service    | What it is                                              | Where                 |
| ---------- | ------------------------------------------------------- | --------------------- |
| PostgreSQL | The database (with PostGIS for map points)              | `127.0.0.1:5432`      |
| Redis      | A fast cache (used later)                               | `127.0.0.1:6379`      |
| Mailpit    | Catches every email the app sends; opens in the browser | http://127.0.0.1:8025 |

## Step 7: create the tables and add sample data

```sh
pnpm --filter @pulse/db db:migrate   # creates the tables (runs the SQL files in packages/db/migrations)
pnpm infra:seed                       # adds AIUB and a demo campus
```

The seed prints `INSERT 0 2` the first time and `INSERT 0 0` after that (it never adds twice).

## Step 8: run the API

```sh
pnpm --filter @pulse/api dev
```

`--filter @pulse/api` means "run this in the `apps/api` package only". `dev` starts the API and
restarts it every time you save a file. You should see:

```
[Nest] …  LOG [Bootstrap] API listening on http://127.0.0.1:3000
```

Leave it running and open a second terminal:

```sh
curl 127.0.0.1:3000/health          # {"status":"ok"}
curl 127.0.0.1:3000/health/ready    # {"status":"ok","checks":{"database":"up"}}
curl 127.0.0.1:3000/campuses        # {"items":[{"…","slug":"aiub",…}]}
```

If you see AIUB, **your setup works.**

## Step 9: run every check once

These are the same checks CI runs on every pull request. Run them now so you know they pass
before you change anything:

```sh
pnpm format:check   # code style (Prettier)
pnpm lint           # code mistakes (ESLint)
pnpm typecheck      # TypeScript types
pnpm test           # unit tests (fast, no Docker)
pnpm test:e2e       # API over HTTP against a real PostgreSQL container (needs Docker, ~1 min)
pnpm build          # compiles everything
```

## Step 10: Postman

1. Open Postman v12 and sign in.
2. Create a workspace, then connect it to the repo folder (**Local View**): Postman reads the
   requests from `postman/` in your clone.
3. Pick the **Pulse local** environment (top right). It sets `{{baseUrl}}` to
   `http://127.0.0.1:3000`.
4. Open **Campuses → Get AIUB** and press **Send**.

From the terminal, with the API running: `pnpm api:postman` runs every request and its tests.

## Every day after this

```sh
cd pulse
git switch main && git pull     # get the team's latest work
pnpm install                    # in case packages changed
pnpm build                      # in case a shared package changed
pnpm infra:up                   # if Docker was stopped
pnpm --filter @pulse/db db:migrate   # in case someone added a migration
pnpm --filter @pulse/api dev
```

## When something goes wrong

| You see                                                | Why                                                  | Fix                                                                                  |
| ------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `Invalid environment: DATABASE_URL: …`                 | No `.env` file, or a value is wrong                  | `cp .env.example .env`                                                               |
| `may bypass row-level security … connect as pulse_app` | `DATABASE_URL` uses the owner role `pulse`           | Use the `pulse_app` URL from `.env.example`                                          |
| `/health/ready` answers 503                            | PostgreSQL is not running                            | `pnpm infra:up`                                                                      |
| `relation "campus" does not exist`                     | Migrations have not run                              | `pnpm --filter @pulse/db db:migrate`                                                 |
| `role "pulse_app" does not exist`                      | Your database volume is older than the role script   | `pnpm infra:reset`, then `infra:up`, `db:migrate`, `infra:seed` (deletes local data) |
| Editor: `Cannot find module '@pulse/contracts'`        | Workspace packages are used from their built `dist/` | `pnpm build` (or `pnpm --filter @pulse/contracts build`), then restart the TS server |
| `EADDRINUSE: … :3000`                                  | The API is already running in another terminal       | Stop the other one (Ctrl+C) or set `PORT=3001`                                       |
| zsh: `no matches found: …@workspace:*`                 | zsh treats `*` as a file pattern                     | Put the argument in quotes: `'@pulse/x@workspace:*'`                                 |
| `Cannot connect to the Docker daemon`                  | Docker is not running                                | Open OrbStack / Docker Desktop                                                       |
