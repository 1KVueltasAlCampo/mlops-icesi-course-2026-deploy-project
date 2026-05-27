FROM python:3.10-slim

WORKDIR /app

# Enable unbuffered logging in Python to see prints in real-time in Docker logs
ENV PYTHONUNBUFFERED=1

# Install system dependencies for audio processing
RUN apt-get update && apt-get install -y \
    libsndfile1 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Upgrade pip to avoid resolver bugs present in older versions (e.g. pip 22.x)
RUN pip install --no-cache-dir --upgrade pip

# Copy requirements first (Docker layer caching: deps only rebuild when requirements.txt changes)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY app.py /app/
COPY static /app/static/

# Expose the application port
EXPOSE 8000

# Command to run the FastAPI server
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
