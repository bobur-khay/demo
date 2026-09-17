# Setup

1. Copy the example environment file:

	```bash
	cp .env.example .env
	```

2. Start the FastAPI server:

	```bash
	cd server
	./.venv/bin/python -m uvicorn app.main:app --reload
	```

3. Start the client in another terminal:

	```bash
	cd client
	npm ci
	npm run dev
	```

4. Open `http://localhost:5173` and check that the live metrics are updating correctly.
