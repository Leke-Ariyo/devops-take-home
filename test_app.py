"""
Unit tests for Fincra Flask Application
"""
import pytest
from app import app


@pytest.fixture
def client():
    """Create test client"""
    app.config['TESTING'] = True
    with app.test_client() as client:
        yield client


def test_hello_endpoint(client):
    """Test main endpoint returns correct message"""
    response = client.get('/')
    assert response.status_code == 200
    assert b'Hello, from Fincra!' in response.data


def test_health_endpoint(client):
    """Test health endpoint returns healthy status"""
    response = client.get('/health')
    assert response.status_code == 200
    data = response.get_json()
    assert data['status'] == 'healthy'


def test_ready_endpoint(client):
    """Test readiness endpoint returns ready status"""
    response = client.get('/ready')
    assert response.status_code == 200
    data = response.get_json()
    assert data['status'] == 'ready'


def test_404_endpoint(client):
    """Test non-existent endpoint returns 404"""
    response = client.get('/nonexistent')
    assert response.status_code == 404
