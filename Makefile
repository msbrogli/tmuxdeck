.PHONY: lint lint-backend lint-frontend nix-build nix-run format test test-backend test-frontend typecheck screenshot all check

# --- Nix ---

nix-build:
	nix build

nix-run:
	nix run

# Run all checks (lint + typecheck + test)
check: lint typecheck test

# --- Linting ---

lint: lint-backend lint-frontend

lint-backend:
	cd backend && uv run ruff check .

lint-frontend:
	cd frontend && npx eslint .

# --- Formatting ---

format:
	cd backend && uv run ruff format .
	cd backend && uv run ruff check --fix .

# --- Type checking ---

typecheck:
	cd frontend && npx tsc -b

# --- Tests ---

test: test-backend test-frontend

test-backend:
	cd backend && uv run pytest --tb=short

test-frontend:
	cd frontend && npx vitest run

screenshot:
	cd frontend && npm run screenshot
