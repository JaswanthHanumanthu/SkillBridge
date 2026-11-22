"""Convenience entry point for running the FastAPI application with Uvicorn."""
import os
import uvicorn


if __name__ == "__main__":
    uvicorn.run("backend.main:app", host="0.0.0.0", port=int(os.getenv("PORT", "8000")), reload=os.getenv("DEBUG", "0").lower() in {"1", "true", "yes"})
