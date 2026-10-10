# Relay de Grilla. Contexto de build: la raíz del repo (docker build -f relay/Dockerfile .)
FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir requests
COPY xtream_client.py video_res.py ./
COPY relay/server.py relay/
ENV PORT=8080
EXPOSE 8080
USER nobody
CMD ["python", "relay/server.py"]
