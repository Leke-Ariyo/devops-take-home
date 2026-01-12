#!/bin/bash
# Fincra DevOps - Deployment Helper Script
# This script helps with local development and manual deployments

set -e

# Configuration
AWS_REGION="${AWS_REGION:-eu-west-1}"
EKS_CLUSTER_NAME="${EKS_CLUSTER_NAME:-fincra-eks-cluster}"
ECR_REPOSITORY="${ECR_REPOSITORY:-fincra-flask-app}"
K8S_NAMESPACE="${K8S_NAMESPACE:-fincra-app}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check required tools
check_prerequisites() {
    log_info "Checking prerequisites..."
    
    local missing_tools=()
    
    command -v aws >/dev/null 2>&1 || missing_tools+=("aws-cli")
    command -v kubectl >/dev/null 2>&1 || missing_tools+=("kubectl")
    command -v docker >/dev/null 2>&1 || missing_tools+=("docker")
    command -v npm >/dev/null 2>&1 || missing_tools+=("npm")
    command -v cdk >/dev/null 2>&1 || missing_tools+=("aws-cdk")
    
    if [ ${#missing_tools[@]} -ne 0 ]; then
        log_error "Missing required tools: ${missing_tools[*]}"
        exit 1
    fi
    
    log_info "All prerequisites are installed"
}

# Build Docker image
build_image() {
    log_info "Building Docker image..."
    
    local tag="${1:-latest}"
    docker build -t "${ECR_REPOSITORY}:${tag}" .
    
    log_info "Image built: ${ECR_REPOSITORY}:${tag}"
}

# Push image to ECR
push_to_ecr() {
    log_info "Pushing image to ECR..."
    
    local tag="${1:-latest}"
    local account_id=$(aws sts get-caller-identity --query Account --output text)
    local ecr_uri="${account_id}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}"
    
    # Login to ECR
    aws ecr get-login-password --region "${AWS_REGION}" | docker login --username AWS --password-stdin "${account_id}.dkr.ecr.${AWS_REGION}.amazonaws.com"
    
    # Tag and push
    docker tag "${ECR_REPOSITORY}:${tag}" "${ecr_uri}:${tag}"
    docker push "${ecr_uri}:${tag}"
    
    log_info "Image pushed: ${ecr_uri}:${tag}"
}

# Deploy CDK infrastructure
deploy_infrastructure() {
    log_info "Deploying CDK infrastructure..."
    
    cd cdk
    npm ci
    cdk deploy --all --require-approval never
    cd ..
    
    log_info "Infrastructure deployment complete"
}

# Deploy application to EKS
deploy_application() {
    log_info "Deploying application to EKS..."
    
    local tag="${1:-latest}"
    local account_id=$(aws sts get-caller-identity --query Account --output text)
    local ecr_uri="${account_id}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}"
    
    # Update kubeconfig
    aws eks update-kubeconfig --name "${EKS_CLUSTER_NAME}" --region "${AWS_REGION}"
    
    # Update deployment image
    kubectl set image deployment/fincra-flask-app flask-app="${ecr_uri}:${tag}" -n "${K8S_NAMESPACE}" || {
        # If deployment doesn't exist, apply manifests
        log_info "Applying Kubernetes manifests..."
        
        # Substitute image in deployment
        sed -i "s|\${ECR_REPOSITORY_URI}:\${IMAGE_TAG}|${ecr_uri}:${tag}|g" k8s/deployment.yaml
        
        kubectl apply -f k8s/namespace.yaml
        kubectl apply -f k8s/deployment.yaml
        kubectl apply -f k8s/service.yaml
        kubectl apply -f k8s/ingress.yaml
    }
    
    # Wait for rollout
    kubectl rollout status deployment/fincra-flask-app -n "${K8S_NAMESPACE}" --timeout=300s
    
    log_info "Application deployment complete"
}

# Get application URL
get_app_url() {
    log_info "Getting application URL..."
    
    local alb_url=$(kubectl get ingress fincra-flask-app -n "${K8S_NAMESPACE}" -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null)
    
    if [ -n "$alb_url" ]; then
        log_info "Application URL: http://${alb_url}"
    else
        log_warn "ALB URL not yet available. Check ingress status with: kubectl get ingress -n ${K8S_NAMESPACE}"
    fi
}

# Run local development server
run_local() {
    log_info "Starting local development server..."
    docker-compose up --build
}

# Show status
show_status() {
    log_info "Showing deployment status..."
    
    aws eks update-kubeconfig --name "${EKS_CLUSTER_NAME}" --region "${AWS_REGION}" 2>/dev/null || {
        log_warn "Could not update kubeconfig. Is the cluster deployed?"
        return 1
    }
    
    echo ""
    echo "=== Namespace ==="
    kubectl get namespace "${K8S_NAMESPACE}" 2>/dev/null || echo "Namespace not found"
    
    echo ""
    echo "=== Deployments ==="
    kubectl get deployments -n "${K8S_NAMESPACE}" 2>/dev/null || echo "No deployments found"
    
    echo ""
    echo "=== Pods ==="
    kubectl get pods -n "${K8S_NAMESPACE}" 2>/dev/null || echo "No pods found"
    
    echo ""
    echo "=== Services ==="
    kubectl get services -n "${K8S_NAMESPACE}" 2>/dev/null || echo "No services found"
    
    echo ""
    echo "=== Ingress ==="
    kubectl get ingress -n "${K8S_NAMESPACE}" 2>/dev/null || echo "No ingress found"
}

# Cleanup
cleanup() {
    log_warn "This will delete all deployed resources!"
    read -p "Are you sure? (y/N) " -n 1 -r
    echo
    
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        log_info "Deleting Kubernetes resources..."
        kubectl delete -f k8s/ --ignore-not-found=true 2>/dev/null || true
        
        log_info "Destroying CDK infrastructure..."
        cd cdk
        cdk destroy --all --force
        cd ..
        
        log_info "Cleanup complete"
    else
        log_info "Cleanup cancelled"
    fi
}

# Print usage
usage() {
    echo "Fincra DevOps - Deployment Helper Script"
    echo ""
    echo "Usage: $0 <command> [options]"
    echo ""
    echo "Commands:"
    echo "  check          Check prerequisites"
    echo "  build [tag]    Build Docker image"
    echo "  push [tag]     Push image to ECR"
    echo "  infra          Deploy CDK infrastructure"
    echo "  deploy [tag]   Deploy application to EKS"
    echo "  url            Get application URL"
    echo "  status         Show deployment status"
    echo "  local          Run local development server"
    echo "  all [tag]      Full deployment (build, push, infra, deploy)"
    echo "  cleanup        Delete all resources"
    echo ""
    echo "Environment Variables:"
    echo "  AWS_REGION       AWS region (default: eu-west-1)"
    echo "  EKS_CLUSTER_NAME EKS cluster name (default: fincra-eks-cluster)"
    echo "  ECR_REPOSITORY   ECR repository name (default: fincra-flask-app)"
    echo "  K8S_NAMESPACE    Kubernetes namespace (default: fincra-app)"
}

# Main
case "${1:-}" in
    check)
        check_prerequisites
        ;;
    build)
        build_image "${2:-latest}"
        ;;
    push)
        push_to_ecr "${2:-latest}"
        ;;
    infra)
        deploy_infrastructure
        ;;
    deploy)
        deploy_application "${2:-latest}"
        ;;
    url)
        get_app_url
        ;;
    status)
        show_status
        ;;
    local)
        run_local
        ;;
    all)
        check_prerequisites
        build_image "${2:-latest}"
        push_to_ecr "${2:-latest}"
        deploy_infrastructure
        deploy_application "${2:-latest}"
        get_app_url
        ;;
    cleanup)
        cleanup
        ;;
    *)
        usage
        ;;
esac
