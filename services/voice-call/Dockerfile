FROM python:3.12-slim

WORKDIR /app

# Install system dependencies for audio processing and building
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libavcodec-dev \
    libavformat-dev \
    libavutil-dev \
    libswresample-dev \
    git \
    gcc \
    libc-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Install pytgcalls from dev branch
RUN pip install --no-cache-dir git+https://github.com/pytgcalls/pytgcalls@dev

# Copy source code
COPY src/ ./src/
COPY scripts/ ./scripts/

# Set Python path
ENV PYTHONPATH=/app/src

# Expose the service port
EXPOSE 8765

# Run the service
CMD ["python", "-m", "lain_voice.main"]
