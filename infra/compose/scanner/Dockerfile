FROM python:3.13-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90
COPY requirements.lock /tmp/requirements.lock
RUN pip install --no-cache-dir --no-deps -r /tmp/requirements.lock && pip check
COPY worker.py /worker.py
ENV PYTHONDONTWRITEBYTECODE=1 HOME=/tmp
USER 65532:65532
CMD ["python", "/worker.py"]
