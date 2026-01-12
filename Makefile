# Fincra DevOps - Makefile
# Provides convenient commands for development and deployment

.PHONY: all build push deploy clean test lint local up down infra help

# Configuration
AWS_REGION ?= eu-west-1
ECR_REPOSITORY ?= fincra-flask-app
EKS_CLUSTER_NAME ?= fincra-eks-cluster
IMAGE_TAG ?= latest

# Default target
all: help

# Docker commands
up: ## Start local development server
	docker-compose -f docker-compose.yml up -d --build

up_log: ## Start local development server with logs
	docker-compose -f docker-compose.yml up --build

down: ## Stop local development server
	docker-compose -f docker-compose.yml down --volumes

build: ## Build Docker image
	docker build -t $(ECR_REPOSITORY):$(IMAGE_TAG) .

# AWS/ECR commands
login: ## Login to Amazon ECR
	aws ecr get-login-password --region $(AWS_REGION) | docker login --username AWS --password-stdin $$(aws sts get-caller-identity --query Account --output text).dkr.ecr.$(AWS_REGION).amazonaws.com

push: login build ## Build and push image to ECR
	@ACCOUNT_ID=$$(aws sts get-caller-identity --query Account --output text) && \
	ECR_URI=$$ACCOUNT_ID.dkr.ecr.$(AWS_REGION).amazonaws.com/$(ECR_REPOSITORY) && \
	docker tag $(ECR_REPOSITORY):$(IMAGE_TAG) $$ECR_URI:$(IMAGE_TAG) && \
	docker push $$ECR_URI:$(IMAGE_TAG)

# CDK commands
cdk-install: ## Install CDK dependencies
	cd cdk && npm ci

cdk-synth: cdk-install ## Synthesize CDK stack
	cd cdk && npx cdk synth

cdk-diff: cdk-install ## Show CDK diff
	cd cdk && npx cdk diff

cdk-deploy: cdk-install ## Deploy CDK infrastructure
	cd cdk && npx cdk deploy --all --require-approval never

cdk-destroy: cdk-install ## Destroy CDK infrastructure
	cd cdk && npx cdk destroy --all --force

infra: cdk-deploy ## Alias for cdk-deploy

# Kubernetes commands
kubeconfig: ## Update kubeconfig for EKS cluster
	aws eks update-kubeconfig --name $(EKS_CLUSTER_NAME) --region $(AWS_REGION)

k8s-apply: kubeconfig ## Apply Kubernetes manifests
	kubectl apply -k k8s/

k8s-delete: kubeconfig ## Delete Kubernetes resources
	kubectl delete -k k8s/ --ignore-not-found=true

k8s-status: kubeconfig ## Show Kubernetes resource status
	@echo "=== Deployments ===" && kubectl get deployments -n fincra-app
	@echo "=== Pods ===" && kubectl get pods -n fincra-app
	@echo "=== Services ===" && kubectl get services -n fincra-app
	@echo "=== Ingress ===" && kubectl get ingress -n fincra-app

deploy: k8s-apply ## Deploy application to Kubernetes

# Testing commands
test: ## Run basic sanity tests
	python -c "from app import app; print('Flask app imports successfully')"

lint: ## Run linting
	pip install flake8 -q
	flake8 . --count --select=E9,F63,F7,F82 --show-source --statistics

# Utility commands
local: up ## Alias for up

clean: down ## Stop containers and clean up
	docker system prune -f

logs: kubeconfig ## View application logs
	kubectl logs -l app=fincra-flask-app -n fincra-app -f

url: kubeconfig ## Get application URL
	@kubectl get ingress fincra-flask-app -n fincra-app -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' && echo ""

port-forward: kubeconfig ## Port forward to local machine
	kubectl port-forward svc/fincra-flask-app 8080:80 -n fincra-app

# Full deployment
full-deploy: push infra deploy ## Full deployment pipeline
	@echo "Deployment complete!"

help: ## Show this help message
	@echo "Fincra DevOps - Available Commands"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'