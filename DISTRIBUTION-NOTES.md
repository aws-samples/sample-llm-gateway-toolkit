# How this toolkit relates to the AWS Multi-Provider GenAI Gateway guidance

AWS publishes the [Multi-Provider GenAI Gateway guidance](https://github.com/aws-solutions-library-samples/guidance-for-multi-provider-generative-ai-gateway-on-aws)
(LiteLLM, Terraform). It is the broad, production-oriented reference — EKS or Fargate, Okta / SSO, WAF,
Guardrails, multi-AZ, and many providers. This toolkit complements it; it doesn't replace it.

## Where this toolkit adds value

- **Local first run** — `docker compose up` gives a working gateway in about 30 seconds, with no AWS
  resources created.
- **One-command AWS deploy** — CDK on ECS Fargate + Aurora Serverless v2 + CloudFront.
- **Self-hosting depth** — staging weights and deploying a model on a SageMaker vLLM endpoint, with the
  operational lessons (quota, the 60s synchronous-invoke limit, streaming).
- **Quality evidence** — a benchmark harness that pilots real coding CLIs through the gateway on your
  own tasks, with hidden tests and an LLM-as-judge.
- **[Self-hosting guide](docs/self-hosting.md)** — compare managed and self-hosted inference on your coding tasks.
- **Prefix-cache hook** — restores KV-cache reuse for Copilot CLI on a self-hosted backend, which cuts
  time to first token.
- **Small baseline footprint** — roughly $150–200/month as shipped, before hardening.

## When to use which

Start with this toolkit to get running quickly, evaluate models and self-host. Use the guidance when you
need its enterprise breadth — EKS, Okta / SSO, WAF / Guardrails, multi-AZ, or more providers.
