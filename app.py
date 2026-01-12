from flask import Flask
import os

app = Flask(__name__)

@app.route('/')
def hello():
    return 'Hello, from Fincra!'

@app.route('/health')
def health():
    return {'status': 'healthy'}, 200

@app.route('/ready')
def ready():
    return {'status': 'ready'}, 200

if __name__ == "__main__":
    port = int(os.environ.get('PORT', 80))
    app.run(host='0.0.0.0', port=port)