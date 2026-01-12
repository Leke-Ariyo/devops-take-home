#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { FincraInfrastructureStack } from '../lib/infrastructure-stack';

const app = new cdk.App();

// Environment configuration - can be overridden via context or environment variables
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID,
  region: process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || 'eu-west-1',
};

// Stack configuration
const config = {
  clusterName: app.node.tryGetContext('clusterName') || 'fincra-eks-cluster',
  environment: app.node.tryGetContext('environment') || 'production',
  vpcCidr: app.node.tryGetContext('vpcCidr') || '10.0.0.0/16',
};

// Create the main infrastructure stack
new FincraInfrastructureStack(app, 'FincraInfrastructureStack', {
  env,
  description: 'Fincra EKS Fargate Infrastructure Stack',
  clusterName: config.clusterName,
  environment: config.environment,
  vpcCidr: config.vpcCidr,
  tags: {
    Project: 'Fincra',
    Environment: config.environment,
    ManagedBy: 'CDK',
    Team: 'DevOps',
  },
});

app.synth();
