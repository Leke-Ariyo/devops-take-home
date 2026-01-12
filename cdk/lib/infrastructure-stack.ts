import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';
import { KubectlV30Layer } from '@aws-cdk/lambda-layer-kubectl-v30';

export interface FincraInfrastructureStackProps extends cdk.StackProps {
  clusterName: string;
  environment: string;
  vpcCidr: string;
}

export class FincraInfrastructureStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly cluster: eks.FargateCluster;
  public readonly applicationSecurityGroup: ec2.SecurityGroup;
  public readonly ecrRepository: ecr.Repository;

  constructor(scope: Construct, id: string, props: FincraInfrastructureStackProps) {
    super(scope, id, props);

    // ===========================================
    // VPC Configuration
    // ===========================================
    this.vpc = new ec2.Vpc(this, 'FincraVpc', {
      vpcName: `${props.clusterName}-vpc`,
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr),
      maxAzs: 3,
      natGateways: 1, // Cost optimization - use 1 NAT Gateway
      
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
          mapPublicIpOnLaunch: true,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
      
      // Enable DNS support for EKS
      enableDnsHostnames: true,
      enableDnsSupport: true,
    });

    // Add VPC Flow Logs for security monitoring
    this.vpc.addFlowLog('FlowLog', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });

    // ===========================================
    // Security Groups
    // ===========================================
    
    // Application Security Group with required firewall rules
    this.applicationSecurityGroup = new ec2.SecurityGroup(this, 'ApplicationSecurityGroup', {
      vpc: this.vpc,
      securityGroupName: `${props.clusterName}-app-sg`,
      description: 'Security group for Fincra Flask application',
      allowAllOutbound: true, // Allow all egress
    });

    // Ingress Rule: Allow HTTP (TCP 80) from everywhere
    this.applicationSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP from internet'
    );

    // Ingress Rule: Allow HTTPS (TCP 443) from everywhere
    this.applicationSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS from internet'
    );

    // Ingress Rule: Allow ICMP (ping) from everywhere
    this.applicationSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.icmpPing(),
      'Allow ICMP ping from internet'
    );

    // Ingress Rule: Allow all TCP traffic within VPC
    this.applicationSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.vpcCidr),
      ec2.Port.allTcp(),
      'Allow all TCP traffic within VPC'
    );

    // Ingress Rule: Allow all UDP traffic within VPC
    this.applicationSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.vpcCidr),
      ec2.Port.allUdp(),
      'Allow all UDP traffic within VPC'
    );

    // ALB Security Group
    const albSecurityGroup = new ec2.SecurityGroup(this, 'ALBSecurityGroup', {
      vpc: this.vpc,
      securityGroupName: `${props.clusterName}-alb-sg`,
      description: 'Security group for Application Load Balancer',
      allowAllOutbound: true,
    });

    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP from internet'
    );

    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS from internet'
    );

    // ===========================================
    // ECR Repository
    // ===========================================
    this.ecrRepository = new ecr.Repository(this, 'FincraAppRepository', {
      repositoryName: 'fincra-flask-app',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      imageScanOnPush: true,
      lifecycleRules: [
        {
          maxImageCount: 10,
          description: 'Keep only 10 most recent images',
        },
      ],
    });

    // ===========================================
    // EKS Fargate Cluster
    // ===========================================
    
    // Create IAM role for Fargate pod execution
    const fargateRole = new iam.Role(this, 'FargatePodExecutionRole', {
      assumedBy: new iam.ServicePrincipal('eks-fargate-pods.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSFargatePodExecutionRolePolicy'),
      ],
    });

    // Create the EKS Fargate cluster
    this.cluster = new eks.FargateCluster(this, 'FincraEksCluster', {
      clusterName: props.clusterName,
      vpc: this.vpc,
      version: eks.KubernetesVersion.V1_30,
      
      // Place control plane in private subnets
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      
      // Enable public endpoint for kubectl access
      endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE,
      
      // Security configuration
      secretsEncryptionKey: undefined, // Use default AWS managed key
      
      // Kubectl layer for Lambda functions
      kubectlLayer: new KubectlV30Layer(this, 'KubectlLayer'),
      
      // Default Fargate profile for kube-system namespace
      defaultProfile: {
        selectors: [
          { namespace: 'kube-system' },
          { namespace: 'default' },
        ],
      },
    });

    // Create Fargate profile for the application namespace
    this.cluster.addFargateProfile('FincraAppProfile', {
      selectors: [
        { namespace: 'fincra-app' },
      ],
      subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      podExecutionRole: fargateRole,
    });

    // Add security group to the cluster
    this.cluster.clusterSecurityGroup.addIngressRule(
      this.applicationSecurityGroup,
      ec2.Port.allTraffic(),
      'Allow traffic from application security group'
    );

    // ===========================================
    // AWS Load Balancer Controller
    // ===========================================
    
    // Create service account for AWS Load Balancer Controller
    const albServiceAccount = this.cluster.addServiceAccount('AWSLoadBalancerController', {
      name: 'aws-load-balancer-controller',
      namespace: 'kube-system',
    });

    // Attach required IAM policy for ALB Controller
    const albPolicyStatements = [
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'iam:CreateServiceLinkedRole',
        ],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'iam:AWSServiceName': 'elasticloadbalancing.amazonaws.com',
          },
        },
      }),
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ec2:DescribeAccountAttributes',
          'ec2:DescribeAddresses',
          'ec2:DescribeAvailabilityZones',
          'ec2:DescribeInternetGateways',
          'ec2:DescribeVpcs',
          'ec2:DescribeVpcPeeringConnections',
          'ec2:DescribeSubnets',
          'ec2:DescribeSecurityGroups',
          'ec2:DescribeInstances',
          'ec2:DescribeNetworkInterfaces',
          'ec2:DescribeTags',
          'ec2:GetCoipPoolUsage',
          'ec2:DescribeCoipPools',
          'elasticloadbalancing:DescribeLoadBalancers',
          'elasticloadbalancing:DescribeLoadBalancerAttributes',
          'elasticloadbalancing:DescribeListeners',
          'elasticloadbalancing:DescribeListenerCertificates',
          'elasticloadbalancing:DescribeSSLPolicies',
          'elasticloadbalancing:DescribeRules',
          'elasticloadbalancing:DescribeTargetGroups',
          'elasticloadbalancing:DescribeTargetGroupAttributes',
          'elasticloadbalancing:DescribeTargetHealth',
          'elasticloadbalancing:DescribeTags',
        ],
        resources: ['*'],
      }),
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'cognito-idp:DescribeUserPoolClient',
          'acm:ListCertificates',
          'acm:DescribeCertificate',
          'iam:ListServerCertificates',
          'iam:GetServerCertificate',
          'waf-regional:GetWebACL',
          'waf-regional:GetWebACLForResource',
          'waf-regional:AssociateWebACL',
          'waf-regional:DisassociateWebACL',
          'wafv2:GetWebACL',
          'wafv2:GetWebACLForResource',
          'wafv2:AssociateWebACL',
          'wafv2:DisassociateWebACL',
          'shield:GetSubscriptionState',
          'shield:DescribeProtection',
          'shield:CreateProtection',
          'shield:DeleteProtection',
        ],
        resources: ['*'],
      }),
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ec2:AuthorizeSecurityGroupIngress',
          'ec2:RevokeSecurityGroupIngress',
        ],
        resources: ['*'],
      }),
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ec2:CreateSecurityGroup',
        ],
        resources: ['*'],
      }),
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ec2:CreateTags',
        ],
        resources: ['arn:aws:ec2:*:*:security-group/*'],
        conditions: {
          StringEquals: {
            'ec2:CreateAction': 'CreateSecurityGroup',
          },
          Null: {
            'aws:RequestTag/elbv2.k8s.aws/cluster': 'false',
          },
        },
      }),
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ec2:CreateTags',
          'ec2:DeleteTags',
        ],
        resources: ['arn:aws:ec2:*:*:security-group/*'],
        conditions: {
          Null: {
            'aws:RequestTag/elbv2.k8s.aws/cluster': 'true',
            'aws:ResourceTag/elbv2.k8s.aws/cluster': 'false',
          },
        },
      }),
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ec2:AuthorizeSecurityGroupIngress',
          'ec2:RevokeSecurityGroupIngress',
          'ec2:DeleteSecurityGroup',
        ],
        resources: ['*'],
        conditions: {
          Null: {
            'aws:ResourceTag/elbv2.k8s.aws/cluster': 'false',
          },
        },
      }),
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'elasticloadbalancing:CreateLoadBalancer',
          'elasticloadbalancing:CreateTargetGroup',
        ],
        resources: ['*'],
        conditions: {
          Null: {
            'aws:RequestTag/elbv2.k8s.aws/cluster': 'false',
          },
        },
      }),
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'elasticloadbalancing:CreateListener',
          'elasticloadbalancing:DeleteListener',
          'elasticloadbalancing:CreateRule',
          'elasticloadbalancing:DeleteRule',
        ],
        resources: ['*'],
      }),
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'elasticloadbalancing:AddTags',
          'elasticloadbalancing:RemoveTags',
        ],
        resources: [
          'arn:aws:elasticloadbalancing:*:*:targetgroup/*/*',
          'arn:aws:elasticloadbalancing:*:*:loadbalancer/net/*/*',
          'arn:aws:elasticloadbalancing:*:*:loadbalancer/app/*/*',
        ],
        conditions: {
          Null: {
            'aws:RequestTag/elbv2.k8s.aws/cluster': 'true',
            'aws:ResourceTag/elbv2.k8s.aws/cluster': 'false',
          },
        },
      }),
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'elasticloadbalancing:AddTags',
          'elasticloadbalancing:RemoveTags',
        ],
        resources: [
          'arn:aws:elasticloadbalancing:*:*:listener/net/*/*/*',
          'arn:aws:elasticloadbalancing:*:*:listener/app/*/*/*',
          'arn:aws:elasticloadbalancing:*:*:listener-rule/net/*/*/*',
          'arn:aws:elasticloadbalancing:*:*:listener-rule/app/*/*/*',
        ],
      }),
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'elasticloadbalancing:ModifyLoadBalancerAttributes',
          'elasticloadbalancing:SetIpAddressType',
          'elasticloadbalancing:SetSecurityGroups',
          'elasticloadbalancing:SetSubnets',
          'elasticloadbalancing:DeleteLoadBalancer',
          'elasticloadbalancing:ModifyTargetGroup',
          'elasticloadbalancing:ModifyTargetGroupAttributes',
          'elasticloadbalancing:DeleteTargetGroup',
        ],
        resources: ['*'],
        conditions: {
          Null: {
            'aws:ResourceTag/elbv2.k8s.aws/cluster': 'false',
          },
        },
      }),
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'elasticloadbalancing:AddTags',
        ],
        resources: [
          'arn:aws:elasticloadbalancing:*:*:targetgroup/*/*',
          'arn:aws:elasticloadbalancing:*:*:loadbalancer/net/*/*',
          'arn:aws:elasticloadbalancing:*:*:loadbalancer/app/*/*',
        ],
        conditions: {
          StringEquals: {
            'elasticloadbalancing:CreateAction': [
              'CreateTargetGroup',
              'CreateLoadBalancer',
            ],
          },
          Null: {
            'aws:RequestTag/elbv2.k8s.aws/cluster': 'false',
          },
        },
      }),
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'elasticloadbalancing:RegisterTargets',
          'elasticloadbalancing:DeregisterTargets',
        ],
        resources: ['arn:aws:elasticloadbalancing:*:*:targetgroup/*/*'],
      }),
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'elasticloadbalancing:SetWebAcl',
          'elasticloadbalancing:ModifyListener',
          'elasticloadbalancing:AddListenerCertificates',
          'elasticloadbalancing:RemoveListenerCertificates',
          'elasticloadbalancing:ModifyRule',
        ],
        resources: ['*'],
      }),
    ];

    albPolicyStatements.forEach((statement) => {
      albServiceAccount.addToPrincipalPolicy(statement);
    });

    // Install AWS Load Balancer Controller via Helm
    const awsLoadBalancerController = this.cluster.addHelmChart('AWSLoadBalancerController', {
      chart: 'aws-load-balancer-controller',
      repository: 'https://aws.github.io/eks-charts',
      namespace: 'kube-system',
      release: 'aws-load-balancer-controller',
      values: {
        clusterName: props.clusterName,
        serviceAccount: {
          create: false,
          name: 'aws-load-balancer-controller',
        },
        region: this.region,
        vpcId: this.vpc.vpcId,
      },
    });

    awsLoadBalancerController.node.addDependency(albServiceAccount);

    // ===========================================
    // Create Application Namespace
    // ===========================================
    const appNamespace = this.cluster.addManifest('FincraAppNamespace', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: 'fincra-app',
        labels: {
          name: 'fincra-app',
          'app.kubernetes.io/managed-by': 'cdk',
        },
      },
    });

    // ===========================================
    // Outputs
    // ===========================================
    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      description: 'VPC ID',
      exportName: 'FincraVpcId',
    });

    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.cluster.clusterName,
      description: 'EKS Cluster Name',
      exportName: 'FincraClusterName',
    });

    new cdk.CfnOutput(this, 'ClusterEndpoint', {
      value: this.cluster.clusterEndpoint,
      description: 'EKS Cluster Endpoint',
      exportName: 'FincraClusterEndpoint',
    });

    new cdk.CfnOutput(this, 'ClusterSecurityGroupId', {
      value: this.cluster.clusterSecurityGroupId,
      description: 'EKS Cluster Security Group ID',
      exportName: 'FincraClusterSecurityGroupId',
    });

    new cdk.CfnOutput(this, 'ApplicationSecurityGroupId', {
      value: this.applicationSecurityGroup.securityGroupId,
      description: 'Application Security Group ID',
      exportName: 'FincraAppSecurityGroupId',
    });

    new cdk.CfnOutput(this, 'EcrRepositoryUri', {
      value: this.ecrRepository.repositoryUri,
      description: 'ECR Repository URI',
      exportName: 'FincraEcrRepositoryUri',
    });

    new cdk.CfnOutput(this, 'KubectlConfigCommand', {
      value: `aws eks update-kubeconfig --name ${this.cluster.clusterName} --region ${this.region}`,
      description: 'Command to configure kubectl',
    });
  }
}
