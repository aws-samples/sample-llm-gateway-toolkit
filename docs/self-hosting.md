# Self-hosting on Amazon SageMaker

Run an open-weight model on a [SageMaker real-time endpoint](https://docs.aws.amazon.com/sagemaker/latest/dg/realtime-endpoints.html) and make it available alongside Bedrock models in LiteLLM. Developers use the same Gateway CLI, connection method, and virtual key; they select the model by its gateway alias.

## When to consider self-hosting

Start with Bedrock for managed model access. Consider SageMaker when you need a specific model checkpoint, control over the inference container, or want to evaluate dedicated GPU capacity for your workload.

| Consideration | What to compare |
| --- | --- |
| **Quality** | Task completion, correct tool calls, and passing tests. |
| **Latency** | Short coding iterations and large-context requests, at the concurrency your team expects. |
| **Cost** | Cost per completed task, including idle GPU capacity, retries, and operations. |
| **Operations** | Who maintains the model, serving image, capacity, and scaling configuration. |

For data residency, check the endpoint Region and the Bedrock model's routing configuration. [Bedrock inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html) can route within a geography or globally.

## Evaluate on your coding tasks

1. Run the same tasks against both backends, including short prompts, large contexts, and conversations with multiple tool calls.
2. Record correctness, time to first token, total completion time, token usage, and cache hits under representative load.
3. Choose a model for a task class only when it meets your quality and latency requirements at an acceptable total cost.

The [benchmark harness](../benchmark/) contains task examples and reporting for the local Docker gateway. Its agents currently run on the host without container isolation.

The gateway uses explicit model aliases. It does not automatically choose between Bedrock and SageMaker based on prompt size or task difficulty.

## Connect a SageMaker endpoint

Use an existing compatible endpoint or the optional [self-hosting example](../self-hosting-cdk/), which stages model weights and deploys a vLLM endpoint.

1. Add the endpoint to `model_list` in [`gateway-cdk/config/litellm-config.yaml`](../gateway-cdk/config/litellm-config.yaml):

   ```yaml
   - model_name: self-hosted
     litellm_params:
       model: sagemaker_chat/<endpoint-name>
       aws_region_name: <endpoint-region>
     model_info:
       supports_streaming: true
       supports_function_calling: true
   ```

   Choose a model and serving configuration that support streaming and tool calls.

2. Add its ARN to the `GatewayStack` properties in [`gateway-cdk/bin/gateway.ts`](../gateway-cdk/bin/gateway.ts):

   ```typescript
   sagemakerEndpointArns: [
     'arn:aws:sagemaker:<region>:<account-id>:endpoint/<endpoint-name>'
   ],
   ```

3. Redeploy using your existing access mode, allow `self-hosted` on your virtual key, and select it with the CLI:

   ```sh
   gateway claude --model self-hosted
   ```

> [!NOTE]
> The self-hosting example has a separate deployment lifecycle. Review its `deploy --dry-run` output: its capacity handling can propose deleting other endpoints using the same instance type. Delete the model endpoint with its script before destroying the self-hosting stack; destroying the gateway does not remove it.
