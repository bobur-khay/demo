# Setup

1. Copy the example environment file:

   ```bash
   cp .env.example .env
   ```

2. Install the server dependencies:

   ```bash
   cd server
   python -m venv .venv
   ./.venv/bin/python -m pip install -r requirements.txt
   ```

3. Start the FastAPI server:

   ```bash
   ./.venv/bin/python -m uvicorn app.main:app --reload
   ```

4. Install the client dependencies and start it in another terminal:

   ```bash
   cd client
   npm ci
   npm run dev
   ```

5. Open `http://localhost:5173` and check that the live metrics are updating correctly.
