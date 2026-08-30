FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Requires the GitHub repo to be public (or a build secret with a read token).
RUN pip install --no-cache-dir "sci-envs[service] @ git+https://github.com/jasonbrelsford/verifiable-science-envs@main"
# Pre-fetch the pinned release so the Space starts warm; cache under a writable home for the HF user.
ENV HOME=/home/user HLA_VERIFY_TAG=v3.65.0-alpha
RUN mkdir -p /home/user && python -c "from sci_envs.reference.imgt import ImgtReference; ImgtReference.load('v3.65.0-alpha')" && chmod -R a+rX /home/user
EXPOSE 7860
CMD ["uvicorn", "sci_envs.service.app:app", "--host", "0.0.0.0", "--port", "7860"]
