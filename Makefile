.PHONY: dev dev-services stop build install migrate seed-admin seed-data lint typecheck test clean clean-all help db-shell build-docker up down logs

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

# No dev-infra target here — this repo owns no Postgres container; start
# msq-core's `make dev-infra` first (see its cross-repo networking note).
dev: install ## Start LMS services + web locally (requires msq-core's infra running)
	$(PNPM) turbo dev --concurrency 20

dev-services: install ## Start LMS backend services (excludes web apps)
	$(PNPM) turbo dev --filter='!./apps/*' --concurrency 12

# ── Database ───────────────────────────────────────────────────────────────────
# DB commands run psql inside the Postgres container (no local psql required).
# Works with both docker-compose and standalone docker-run containers.
DB_CONTAINER  ?= $(DB_CONTAINER_NAME)
DB_CONTAINER_NAME ?= msq-db-server
POSTGRES_USER ?= postgres

define run_sql
	docker cp $(1) $(DB_CONTAINER):/tmp/$(notdir $(1))
	docker exec $(DB_CONTAINER) psql -U $(POSTGRES_USER) -d $(DB_NAME) -f /tmp/$(notdir $(1))
endef

# migrate/seed-admin run db_scripts/01_init-db.sql & 02-seed-tenants-orgs-users.sql,
# which are still schema-interleaved (shared iam/entity/geo alongside lms/marketing/
# ext) — this repo cannot bootstrap a database alone, see db_scripts/db_deploy.ps1.
migrate: ## Run database schema (db_scripts/01_init-db.sql)
	$(call run_sql,db_scripts/01_init-db.sql)

seed-admin: ## Seed tenants, orgs, and users (db_scripts/02-seed-tenants-orgs-users.sql)
	$(call run_sql,db_scripts/02-seed-tenants-orgs-users.sql)

seed-data: ## Seed leads, interactions, and follow-ups (run after seed-admin)
	$(call run_sql,db_scripts/03-seed-leads-bulk.sql)
	$(call run_sql,db_scripts/04-seed-interactions-followups.sql)
	$(call run_sql,db_scripts/05-cleanup-seed-helpers.sql)

db-shell: ## Open a psql shell in the Postgres container
	docker exec -it $(DB_CONTAINER) psql -U $(POSTGRES_USER) -d $(DB_NAME)

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
# scripts/clean.js lives in msq-core only — this repo uses turbo's own clean.
clean: ## Remove build artefacts (dist/.turbo/tsbuildinfo/.next in every workspace)
	$(PNPM) turbo clean

clean-all: clean ## Remove build artefacts AND all node_modules (full reset — run make install after)
	$(PNPM) exec rimraf node_modules "packages/*/node_modules" "services/*/node_modules" "apps/*/node_modules"
