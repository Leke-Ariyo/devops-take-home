# Use the official Python image from the Docker Hub
FROM python:3.10-slim

# Set the working directory in the container
WORKDIR /app

# Copy the requirements file into the container
COPY requirements.txt .

# Install the required packages
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application code into the container
COPY . .

# Expose port 80
EXPOSE 80

# Run with Gunicorn (production WSGI server)
# - 4 workers for handling concurrent requests
# - Bind to port 80
CMD ["gunicorn", "--bind", "0.0.0.0:80", "--workers", "4", "--access-logfile", "-", "app:app"]
