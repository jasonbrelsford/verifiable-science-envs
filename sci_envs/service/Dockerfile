FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml README.md ./
COPY sci_envs ./sci_envs
RUN pip install --no-cache-dir ".[service]"
# Pre-fetch the pinned release at build time so cold starts are fast; runtime re-verifies md5.
RUN python -c "from sci_envs.reference.imgt import ImgtReference; ImgtReference.load(__import__("os").environ.get("HLA_VERIFY_TAG","v3.65.0-alpha"))"
EXPOSE 8000
CMD ["uvicorn", "sci_envs.service.app:app", "--host", "0.0.0.0", "--port", "8000"]
