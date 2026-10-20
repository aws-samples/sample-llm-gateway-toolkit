# Self-hosting — a model on your own SageMaker endpoint (optional)

Run an open-weight model on a SageMaker endpoint and add it to the gateway next to the Bedrock models.
Example: [`Qwen/Qwen3.8-27B`](https://huggingface.co/Qwen/Qwen3.8-27B) (public, Apache-2.0, no Hugging Face
account needed) on one L40S GPU (`ml.g6e.2xlarge`). Cost: about $2.61/hr while the endpoint exists.

```
self-hosting-cdk/
├── bin/ lib/ …                  CDK stack: a weights bucket and two IAM roles
└── scripts/
    ├── stage_qwen38_ec2.sh      copies the model into the bucket (a throwaway EC2)
    └── deploy_qwen38.py         creates and deletes the endpoint
```

## What you need

- An AWS account and one Region for everything: `export AWS_REGION=eu-north-1` (the default). Credentials from
  a profile, SSO (`export AWS_PROFILE=NAME`) or environment keys.
- Python 3.10+ and Node 20+.
- **GPU quota:** *ml.g6e.2xlarge for endpoint usage* ≥ 1 in the Region. New accounts start at 0:
  ```bash
  aws service-quotas list-service-quotas --service-code sagemaker --region $AWS_REGION \
    --query "Quotas[?QuotaName=='ml.g6e.2xlarge for endpoint usage'].Value" --output text
  # 0.0 → aws service-quotas request-service-quota-increase --service-code sagemaker \
  #         --quota-code L-F8D7F460 --desired-value 1 --region $AWS_REGION
  ```
- CDK bootstrapped in the Region (once per account and Region).

## Steps

Run everything from this folder.

```bash
# 1. The weights bucket and two IAM roles
npm install
npx cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/$AWS_REGION   # only if needed
npx cdk deploy

# 2. Copy the model into your bucket: a throwaway EC2 downloads ~55 GB, then deletes itself
./scripts/stage_qwen38_ec2.sh        # Ctrl-C is safe; re-attach with --watch

# 3. Start the endpoint (about 20-40 min); --dry-run first shows the plan and creates nothing
python3 -m pip install boto3
./scripts/deploy_qwen38.py deploy
```

4. **Test it.** `deploy` prints a test request. SageMaker only accepts signed requests, so use the AWS CLI:
   ```bash
   aws sagemaker-runtime invoke-endpoint --region $AWS_REGION --endpoint-name qwen38-2xl-27b-fp8 \
     --content-type application/json --cli-binary-format raw-in-base64-out \
     --body '{"messages":[{"role":"user","content":"Say hi in one short sentence."}],"max_tokens":64,"chat_template_kwargs":{"enable_thinking":false}}' /dev/stdout
   ```
   To use it from the gateway, add this route to `gateway-local/config.yaml` or
   `gateway-cdk/config/litellm-config.yaml`, then test with plain `curl` against the gateway:
   ```yaml
     - model_name: qwen38-2xl-27b-fp8
       litellm_params:
         model: sagemaker_chat/qwen38-2xl-27b-fp8
         aws_region_name: eu-north-1        # the endpoint's Region
       model_info:
         input_cost_per_second: 0.00072372  # $2.6/hr ml.g6e.2xlarge ÷ 3600
         supports_streaming: true           # SageMaker's non-streaming invoke stops at 60 s
   ```
5. **Remove it** — the endpoint bills while it exists. Endpoint first, then the stack:
   ```bash
   ./scripts/deploy_qwen38.py delete
   npx cdk destroy                      # also deletes the weights
   ```

If a step can't run, the script stops and prints the command that fixes it.

## What it creates

| Resource | Name | Used for |
|---|---|---|
| S3 bucket | `sagemaker-qwen38-vllm-<account>-<region>` | the model weights (~55 GB) |
| IAM role + instance profile | `qwen38-stager-builder` | the staging EC2: write to `models/` only |
| IAM role | `qwen38-sagemaker-exec` | the endpoint: read `models/`, pull the AWS vLLM image, write logs |

Staging also launches one `c7i.4xlarge` for the copy; `deploy` creates the SageMaker model, config and
endpoint. Names are fixed (the scripts look them up), so use one stack per account: IAM role names are global,
and the bucket name must not already exist in your account (if it does: `npx cdk deploy -c weightsBucketName=NAME`, then run the scripts with `BUCKET=NAME`).
cdk-nag runs on every synth; accepted findings are acknowledged with reasons in `lib/self-hosting-stack.ts`.
