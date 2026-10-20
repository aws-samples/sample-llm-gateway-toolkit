import { GATEWAY_URL_SCHEMA } from '../schemas/gateway-url.ts';
import { PORT_SCHEMA } from '../schemas/port.ts';
import type { Output } from '@aws-sdk/client-cloudformation';
import type { Task } from '@aws-sdk/client-ecs';
import type { SsmOptions } from '../schemas/ssm.ts';

import {
  CloudFormationClient,
  DescribeStacksCommand
} from '@aws-sdk/client-cloudformation';
import {
  DescribeTasksCommand,
  ECSClient,
  paginateListTasks
} from '@aws-sdk/client-ecs';

/**
 * Reads a required output from the gateway stack.
 * @param outputs - Outputs returned by CloudFormation.
 * @param key - Output name defined by the gateway stack.
 */
const getOutput = (outputs: readonly Output[], key: string) => {
  const value = outputs.find(output => output.OutputKey === key)?.OutputValue;

  if (!value) {
    throw new Error(`The gateway stack has no ${key} output.`);
  }

  return (value);
};

/**
 * Builds a session target when the LiteLLM container is ready for ECS Exec.
 * @param cluster - ECS cluster name from the stack outputs.
 * @param task - Task returned by ECS.
 */
const getSessionTarget = (cluster: string, task: Task) => {
  const taskId = task.taskArn?.split('/').pop();
  const container = task.containers?.find(({ name }) => name === 'litellm');
  const agent = container?.managedAgents?.find(
    ({ name }) => name === 'ExecuteCommandAgent'
  );

  if (
    task.desiredStatus !== 'RUNNING' ||
    task.lastStatus !== 'RUNNING' ||
    !task.enableExecuteCommand ||
    !taskId ||
    !container?.runtimeId ||
    container.lastStatus !== 'RUNNING' ||
    agent?.lastStatus !== 'RUNNING'
  ) {
    return (undefined);
  }

  return (`ecs:${cluster}_${taskId}_${container.runtimeId}`);
};

/**
 * Discovers the gateway deployment and a task ready for private access.
 * @param options - Validated AWS connection settings.
 * @param signal - Cancellation controlled by the CLI.
 * @param expectedGatewayUrl - Public URL to match when both transports are configured.
 */
export const getGateway = async (
  options: SsmOptions,
  signal: AbortSignal,
  expectedGatewayUrl?: string
) => {
  const config = {
    region: options.region,
    profile: options.profile
  };
  const cloudformation = new CloudFormationClient(config);
  const ecs = new ECSClient(config);

  try {
    signal.throwIfAborted();

    const response = await cloudformation.send(new DescribeStacksCommand({
      StackName: options.stack
    }), {
      abortSignal: signal
    });
    const stack = response.Stacks?.[0];

    if (!stack?.StackId) {
      throw new Error('CloudFormation did not return a gateway stack identifier.');
    }

    const outputs = stack.Outputs ?? [];
    const gatewayUrl = GATEWAY_URL_SCHEMA.optional().parse(
      outputs.find(output => output.OutputKey === 'GatewayUrl')?.OutputValue
    );

    // Both transports must lead to the same deployed gateway.
    if (expectedGatewayUrl !== undefined && gatewayUrl !== expectedGatewayUrl) {
      throw new Error(
        'This AWS stack does not match the configured public gateway.'
      );
    }

    const cluster = getOutput(outputs, 'ClusterName');
    const service = getOutput(outputs, 'ServiceName');
    const remotePort = PORT_SCHEMA.parse(getOutput(outputs, 'GatewayPort'));
    const pages = paginateListTasks({
      client: ecs
    }, {
      cluster,
      serviceName: service,
      desiredStatus: 'RUNNING'
    }, {
      abortSignal: signal
    });

    for await (const page of pages) {
      if (!page.taskArns?.length) {
        continue;
      }

      const described = await ecs.send(new DescribeTasksCommand({
        cluster,
        tasks: page.taskArns
      }), {
        abortSignal: signal
      });
      const target = described.tasks
        ?.map(task => getSessionTarget(cluster, task))
        .find(target => target !== undefined);

      if (target) {
        // Return the full ARN so login can retain the deployment identity.
        return ({
          stack: stack.StackId,
          region: await cloudformation.config.region(),
          gatewayUrl,
          target,
          remotePort
        });
      }
    }

    throw new Error(
      'No LiteLLM task is ready for SSM. Check that the service is running with ECS Exec enabled.'
    );
  } finally {
    cloudformation.destroy();
    ecs.destroy();
  }
};
