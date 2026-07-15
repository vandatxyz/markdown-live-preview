.PHONY: setup
setup:
	npm install

.PHONY: clean
clean:
	rm -rf dist

.PHONY: build
build:
	npm run build

.PHONY: dev
dev:
	npm run dev

.PHONY: start
start:
	npm run start

.PHONY: build-start
build-start:
	npm run build && npm run start
