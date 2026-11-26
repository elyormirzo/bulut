FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY worker.py /app/worker.py
CMD ["python", "-u", "/app/worker.py"]
