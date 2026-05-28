.PHONY: help install check test typecheck dev-api dev-web dev-site extension-build extension-package docker-build release-build-image release-build-image-nocache local-container local-container-down local-container-logs local-container-test migrate prod-container prod-container-pull prod-container-migrate prod-container-down clean test-web-browser build-site release-ready ship-tag

ENV_FILE ?= .env.local-container
PROD_ENV_FILE ?= .env.localprod
LOCAL_IMAGE ?= possiblymadebyahuman-local:latest
RELEASE_IMAGE ?= possiblymadebyahuman
PROD_IMAGE ?= ghcr.io/juanre/possiblymadebyahuman:latest
IMAGE ?= possiblymadebyahuman:latest
PMBAH_PORT ?= 8000
DOCKER_PLATFORM ?= linux/amd64
RELEASE_PLATFORM ?= linux/amd64
LOCAL_COMPOSE = ENV_FILE=$(ENV_FILE) LOCAL_IMAGE=$(LOCAL_IMAGE) docker compose --env-file $(ENV_FILE) -f docker-compose.local-container.yml -p pmbah-local
PROD_COMPOSE = IMAGE=$(PROD_IMAGE) ENV_FILE=$(PROD_ENV_FILE) docker compose --env-file $(PROD_ENV_FILE) -f docker-compose.prod.yml -p pmbah-prod

help:
	@echo "possiblymadebyahuman targets:"
	@echo "  make install               Install npm workspace dependencies"
	@echo "  make check                 Run typecheck + tests"
	@echo "  make test                  Run tests only"
	@echo "  make typecheck             Run TypeScript typecheck"
	@echo "  make dev-api               Run API locally against DATABASE_URL"
	@echo "  make dev-web               Run Vite record app dev server"
	@echo "  make dev-site              Run Hugo site dev server"
	@echo "  make extension-build       Build the Chrome/Chromium extension into apps/browser-extension/dist"
	@echo "  make extension-package     Build deterministic extension zip artifact"
	@echo "  make docker-build          Build single production image ($(IMAGE))"
	@echo "  make release-build-image   Build production release image ($(RELEASE_IMAGE):latest)"
	@echo "  make release-build-image-nocache Build production release image without Docker cache"
	@echo "  make local-container       Build/start app + local Postgres, migrate, wait for /ready"
	@echo "  make local-container-test  Run full local Docker+Postgres HTTP e2e journey"
	@echo "  make local-container-logs  Tail local container logs"
	@echo "  make local-container-down  Stop local stack"
	@echo "  make migrate               Run checked, ordered migrations against DATABASE_URL"
	@echo "  make prod-container        Run prod-like container against external Neon DATABASE_URL"
	@echo "  make prod-container-pull   Pull configured PROD_IMAGE when it is remote"
	@echo "  make prod-container-migrate Run migrations against external Neon DATABASE_URL"
	@echo "  make prod-container-down   Stop prod-like stack"
	@echo "  make test-web-browser      Build web app and run Playwright smoke for the record page"
	@echo "  make build-site            Build the Hugo landing/docs/blog into apps/site/public"
	@echo "  make release-ready         Run release readiness checks and build a release image"
	@echo "  make ship-tag VERSION=X.Y.Z Run release-ready, tag vX.Y.Z, and push tag"
	@echo "  make clean                 Remove safe local build/test output"
	@echo ""
	@echo "Ports: app=$${PMBAH_PORT:-$(PMBAH_PORT)} postgres=$${POSTGRES_PORT:-5432}"

install:
	npm install

check:
	npm run check

test:
	npm test

typecheck:
	npm run typecheck

dev-api:
	@test -n "$(DATABASE_URL)" || (echo "DATABASE_URL is required" && exit 1)
	npm run serve

dev-web:
	npm --workspace @possiblymadebyahuman/web run dev

dev-site:
	command -v hugo >/dev/null || (echo "hugo is required for dev-site" && exit 1)
	hugo server --source apps/site --bind 0.0.0.0 --port $${SITE_PORT:-1313}

extension-build:
	npm --workspace @possiblymadebyahuman/browser-extension run build

extension-package:
	npm --workspace @possiblymadebyahuman/browser-extension run package

docker-build:
	docker build --platform $(DOCKER_PLATFORM) -t $(IMAGE) .

release-build-image:
	@echo "Building production release image $(RELEASE_IMAGE):latest for $(RELEASE_PLATFORM)..."
	docker build --platform $(RELEASE_PLATFORM) -t $(RELEASE_IMAGE):latest .

release-build-image-nocache:
	@echo "Building production release image without cache $(RELEASE_IMAGE):latest for $(RELEASE_PLATFORM)..."
	docker build --platform $(RELEASE_PLATFORM) --no-cache -t $(RELEASE_IMAGE):latest .

local-container: docker-build
	@test -f "$(ENV_FILE)" || (echo "Missing $(ENV_FILE). Copy .env.local-container.example first." && exit 1)
	@echo "Starting local Postgres..."
	$(LOCAL_COMPOSE) up -d postgres
	@echo "Waiting for Postgres..."
	@for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do \
		if $(LOCAL_COMPOSE) exec -T postgres pg_isready -U "$${POSTGRES_USER:-pmbah}" -d "$${POSTGRES_DB:-pmbah}" >/dev/null 2>&1; then break; fi; \
		sleep 2; \
	done
	@echo "Running migrations..."
	$(LOCAL_COMPOSE) run --rm --no-deps app npm run migrate
	@echo "Starting app..."
	$(LOCAL_COMPOSE) up -d --force-recreate app
	@echo "Waiting for readiness..."
	@for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do \
		if curl -fsS "http://localhost:$${PMBAH_PORT:-$(PMBAH_PORT)}/ready" >/dev/null 2>&1; then echo "Ready: http://localhost:$${PMBAH_PORT:-$(PMBAH_PORT)}"; exit 0; fi; \
		sleep 3; \
	done; \
	echo "ERROR: readiness check failed"; exit 1

local-container-test:
	SMOKE_BASE_URL="http://localhost:$${PMBAH_PORT:-$(PMBAH_PORT)}" npm run smoke:local-container

local-container-logs:
	$(LOCAL_COMPOSE) logs -f app postgres

local-container-down:
	@env_file="$(ENV_FILE)"; if [ ! -f "$$env_file" ]; then env_file=.env.local-container.example; fi; \
	ENV_FILE="$$env_file" LOCAL_IMAGE=$(LOCAL_IMAGE) docker compose --env-file "$$env_file" -f docker-compose.local-container.yml -p pmbah-local down

migrate:
	@test -n "$(DATABASE_URL)" || (echo "DATABASE_URL is required" && exit 1)
	npm run migrate

prod-container-pull:
	@test -f "$(PROD_ENV_FILE)" || (echo "Missing $(PROD_ENV_FILE). Copy .env.localprod.example or .env.production.example first." && exit 1)
	@case "$(PROD_IMAGE)" in */*) echo "Pulling $(PROD_IMAGE)..."; $(PROD_COMPOSE) pull ;; *) echo "Using local image $(PROD_IMAGE) (skipping pull)" ;; esac

prod-container: prod-container-pull
	@test -f "$(PROD_ENV_FILE)" || (echo "Missing $(PROD_ENV_FILE). Copy .env.localprod.example or .env.production.example first." && exit 1)
	$(PROD_COMPOSE) up -d

prod-container-migrate:
	@test -f "$(PROD_ENV_FILE)" || (echo "Missing $(PROD_ENV_FILE). Copy .env.localprod.example or .env.production.example first." && exit 1)
	$(PROD_COMPOSE) run --rm --no-deps app npm run migrate

prod-container-down:
	@env_file="$(PROD_ENV_FILE)"; if [ ! -f "$$env_file" ]; then env_file=.env.localprod.example; fi; \
	IMAGE=$(PROD_IMAGE) ENV_FILE="$$env_file" docker compose --env-file "$$env_file" -f docker-compose.prod.yml -p pmbah-prod down

test-web-browser:
	npm run build:web
	npm run test:web-browser

build-site:
	command -v hugo >/dev/null || (echo "hugo is required for build-site" && exit 1)
	hugo --source apps/site --destination public --minify

release-ready:
	git diff --quiet
	git diff --cached --quiet
	$(MAKE) check
	$(MAKE) test-web-browser
	$(MAKE) build-site
	$(MAKE) extension-package
	$(MAKE) release-build-image RELEASE_IMAGE=possiblymadebyahuman-release-ready
	@echo "Release-ready checks passed. Next: make ship-tag VERSION=x.y.z after human approval."

ship-tag: release-ready
	@test -n "$(VERSION)" || (echo "VERSION is required (example: make ship-tag VERSION=0.1.0)" && exit 1)
	@set -eu; \
		tag="v$(VERSION)"; \
		git tag -l "$$tag" | grep -q . && echo "Tag $$tag already exists" && exit 1 || true; \
		git tag -a "$$tag" -m "$$tag"; \
		echo "Pushing $$tag to origin; GitHub Actions will publish GHCR image tags."; \
		git push origin "$$tag"

clean:
	rm -rf apps/web/dist apps/site/public apps/browser-extension/dist coverage
