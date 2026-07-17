.PHONY: dev dev-infra dev-services stop build install migrate migrate-leave migrate-attendance accrue-leave accrue-leave-cycle-end resolve-attendance seed-admin seed-data lint typecheck test clean clean-all help db-shell build-docker up down logs

# ── Variables ──────────────────────────────────────────────────────────────────
COMPOSE := docker compose
PNPM    := pnpm
DB_NAME ?= crm
DB_URL  ?= postgres://postgres:Passw0rd@localhost:5432/$(DB_NAME)

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-22s\033[0m %s\n", $$1, $$2}'

# ── Development ────────────────────────────────────────────────────────────────
install: ## Install all workspace dependencies
	$(PNPM) install

dev: install dev-infra ## Start the full stack locally (Postgres + all services + web)
	$(PNPM) turbo dev --concurrency 20

dev-infra: ## Start Postgres in Docker and wait until healthy
	$(COMPOSE) up -d --wait postgres

dev-services: install ## Start all backend services and the API gateway
	$(PNPM) turbo dev --filter='!web' --concurrency 12

# ── Database ───────────────────────────────────────────────────────────────────
# DB commands run psql inside the Postgres container (no local psql required).
# Works with both docker-compose and standalone docker-run containers.
DB_CONTAINER  ?= $(DB_CONTAINER_NAME)
DB_CONTAINER_NAME ?= crm-db-server
POSTGRES_USER ?= postgres

define run_sql
	docker cp $(1) $(DB_CONTAINER):/tmp/$(notdir $(1))
	docker exec $(DB_CONTAINER) psql -U $(POSTGRES_USER) -d $(DB_NAME) -f /tmp/$(notdir $(1))
endef

migrate: ## Run database schema (db_scripts/01_init-db.sql)
	$(call run_sql,db_scripts/01_init-db.sql)

seed-admin: ## Seed tenants, orgs, and users (db_scripts/02-seed-tenants-orgs-users.sql)
	$(call run_sql,db_scripts/02-seed-tenants-orgs-users.sql)

seed-data: ## Seed leads, interactions, and follow-ups (run after seed-admin)
	$(call run_sql,db_scripts/03-seed-leads-bulk.sql)
	$(call run_sql,db_scripts/04-seed-interactions-followups.sql)
	$(call run_sql,db_scripts/05-cleanup-seed-helpers.sql)

migrate-leave: ## Apply leave-management schema (db_scripts/11 + 12)
	$(call run_sql,db_scripts/11_init-leave-management.sql)
	$(call run_sql,db_scripts/12_leave_ledger_idempotency.sql)

migrate-attendance: ## Apply attendance schema (db_scripts/13)
	$(call run_sql,db_scripts/13_init-attendance.sql)

accrue-leave: ## Run the leave accrual job for the current period (idempotent)
	$(PNPM) --filter @crm/hr-service accrue-leave

accrue-leave-cycle-end: ## Run cycle-end carry-forward/lapse processing
	$(PNPM) --filter @crm/hr-service accrue-leave -- --cycle-end

resolve-attendance: ## Run the nightly attendance resolution job (idempotent, last 3 days)
	$(PNPM) --filter @crm/hr-service resolve-attendance

db-shell: ## Open a psql shell in the Postgres container
	docker exec -it $(DB_CONTAINER) psql -U $(POSTGRES_USER) -d $(DB_NAME)

setup-env: ## Generate per-service .env files from root .env
	node scripts/setup-env.js

# ── Build ──────────────────────────────────────────────────────────────────────
build: install ## Build all packages and services
	$(PNPM) turbo build

build-docker: ## Build all Docker images
	$(COMPOSE) build

# ── Code Quality ───────────────────────────────────────────────────────────────
lint: ## Lint all workspaces
	$(PNPM) turbo lint

typecheck: ## Type-check all workspaces
	$(PNPM) turbo typecheck

test: ## Run all tests
	$(PNPM) turbo test

# ── Infra Lifecycle ────────────────────────────────────────────────────────────
up: ## Start full stack via Docker Compose (production-like)
	$(COMPOSE) up --build -d

down: ## Tear down all Docker Compose services
	$(COMPOSE) down

stop: ## Stop running Docker Compose services (keep volumes)
	$(COMPOSE) stop

logs: ## Stream Docker Compose logs
	$(COMPOSE) logs -f

# ── Cleanup ────────────────────────────────────────────────────────────────────
clean: ## Remove build artefacts (dist/.turbo/tsbuildinfo/.next in every workspace)
	node scripts/clean.js build

clean-all: ## Remove build artefacts AND all node_modules (full reset — run make install after)
	node scripts/clean.js all
