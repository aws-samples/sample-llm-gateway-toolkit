#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Deploy Qwen3.8-27B to a SageMaker vLLM endpoint (1x L40S, fp8 weights + fp8 KV).

MODEL — Qwen/Qwen3.8-27B (Apache-2.0, not gated). model_type qwen3_5, hybrid (16/64 full-attention,
48 Gated-DeltaNet) + vision, reasoning on by default.

⚠️ The checkpoint is bf16 (51.75 GiB, 18 safetensors), NOT pre-quantized. So vLLM quantizes on the
   fly (SM_VLLM_QUANTIZATION=fp8); without that it loads full bf16 and won't fit one card.
SM_VLLM_MAMBA_CACHE_MODE=align is set because qwen3_5 needs it ("all" raises NotImplementedError). The deploy
   re-reads the model and refuses to continue if it didn't land. vLLM logs that it uses "none" while
   prefix caching is off; that is expected.

FIT on ml.g6e.2xlarge: weights 28.06 GiB, KV pool 9.93 GiB = 311,860 tokens ≈ 2.4 concurrent 131k
requests (measured on a checkpoint with identical weight shapes — confirm in the boot log on your
first deploy). OOM after load -> MAX_MODEL_LEN=65536 MAX_NUM_SEQS=4. More concurrency ->
INSTANCE_TYPE=ml.g6e.12xlarge TENSOR_PARALLEL_SIZE=4 (~$12/hr).

Thinking effort per request: chat_template_kwargs.reasoning_effort = xhigh (default) | medium | low.

SETUP (once per Region; the IAM roles and the weights bucket live in a small optional CDK stack)
  npm install && AWS_REGION=<region> npx cdk deploy      # in the folder above
  ./scripts/stage_qwen38_ec2.sh                # copies the weights into the stack's bucket

USAGE
  ./scripts/deploy_qwen38.py deploy            # uses the stack's execution role (qwen38-sagemaker-exec)
  ./scripts/deploy_qwen38.py deploy --exec-role NAME   # or any other SageMaker execution role (name or ARN)
  ./scripts/deploy_qwen38.py deploy --dry-run  # preflight + print the plan, create nothing
  ./scripts/deploy_qwen38.py delete            # tear down (stops billing; S3 weights kept)
  QUANTIZATION= KV_CACHE_DTYPE=auto ./scripts/deploy_qwen38.py deploy   # bf16 fallback

CREDENTIALS — any standard AWS setup works: --profile NAME (or AWS_PROFILE), IAM Identity Center /
SSO profiles (run `aws sso login --profile NAME` first), env-var keys, or an instance/role.

Every tuning knob below is an environment variable, as in the previous bash version.
"""
import argparse
import os
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

if sys.version_info < (3, 10):   # noqa: UP036  # this script needs 3.10+
    sys.exit(f"✗ Python 3.10 or newer is required (this is {sys.version.split()[0]}). "
             f"Try:  python3.12 {sys.argv[0]} ...")

try:
    import boto3
    from botocore.exceptions import BotoCoreError, ClientError
except ImportError:
    sys.exit("✗ boto3 is not installed: python3 -m pip install boto3")


# Instance families with native fp8 (Ada / Hopper / Blackwell).
FP8_INSTANCE_PREFIXES = ("ml.g6e.", "ml.g7e.", "ml.p5.", "ml.p5e.", "ml.p6.")
APPROX_PRICE = {"ml.g6e.2xlarge": "~$2.61/hr", "ml.g6e.12xlarge": "~$12/hr"}
# Files the endpoint cannot load the model without (a vision model needs its preprocessor config too).
REQUIRED_FILES = ("config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json",
                  "vocab.json", "merges.txt", "model.safetensors.index.json")
VARIANT_FIELDS_NEEDED = ("InferenceAmiVersion", "CapacityReservationConfig")
# Created by the CDK stack in the folder above; the name must match lib/self-hosting-stack.ts.
DEFAULT_EXEC_ROLE = "qwen38-sagemaker-exec"
STACK_DIR = Path(__file__).resolve().parent.parent   # the self-hosting-cdk folder (scripts/ lives in it)


# ── Console output ───────────────────────────────────────────────────────────
class DeployError(Exception):
    """Fatal, user-facing error. main() prints it as '✗ <message>' and exits with status 1."""


def info(message: str = "") -> None:
    print(message, flush=True)


def ok(message: str) -> None:
    print(f"✅ {message}", flush=True)


def warn(message: str) -> None:
    print(f"⚠️  {message}", flush=True)


def now() -> str:
    return datetime.now().strftime("%H:%M:%S")


def banner(*lines: str) -> None:
    rule = "═" * 64
    info(rule)
    for line in lines:
        info(f" {line}")
    info(rule)


def is_interactive() -> bool:
    return sys.stdin.isatty()


def countdown(seconds: int, label: str) -> None:
    """Gives an interactive user `seconds` to press Ctrl-C; returns immediately otherwise."""
    if not is_interactive() or seconds <= 0:
        info("    (non-interactive shell - proceeding immediately)")
        return
    info(f"    {label} in {seconds}s - press Ctrl-C to cancel.")
    for remaining in range(seconds, 0, -1):
        print(f"\r    ...{remaining:2d}s ", end="", flush=True)
        time.sleep(1)  # nosemgrep: arbitrary-sleep  (one-second tick of the countdown)
    print("\r    proceeding.        ", flush=True)


def confirm(question: str) -> bool:
    """Asks a yes/no question on the terminal (default: no)."""
    with open("/dev/tty", encoding="utf-8") as tty:
        print(f"    {question} [y/N] ", end="", flush=True)
        return tty.readline().strip().lower() in ("y", "yes")


# ── SageMaker ────────────────────────────────────────────────────────────────
# create-endpoint rejected because the account quota still counts the slot as used.
QUOTA_REJECTION = re.compile(r"ResourceLimitExceeded|service limit|current utilization", re.I)
# Endpoint boot failed because AWS had no GPU capacity.
CAPACITY_FAILURE = re.compile(r"InsufficientInstanceCapacity|capacity|ResourceLimitExceeded", re.I)


# ── Small wrappers ───────────────────────────────────────────────────────────
def error_message(err: ClientError) -> str:
    error = err.response.get("Error", {})
    return f"{error.get('Code', '')}: {error.get('Message', str(err))}"


def is_not_found(err: ClientError) -> bool:
    error = err.response.get("Error", {})
    return "Could not find" in error.get("Message", "") or error.get("Code") in ("ResourceNotFound", "NotFound")


def ignore_missing(call, **kwargs) -> bool:
    """Runs a delete/describe call; returns False when the resource is gone. Any other error is raised."""
    try:
        call(**kwargs)
        return True
    except ClientError as err:
        if is_not_found(err):
            return False
        raise


def paginate(sm, operation: str, key: str, **kwargs) -> list:
    items = []
    for page in sm.get_paginator(operation).paginate(**kwargs):
        items.extend(page[key])
    return items


def endpoint_exists(sm, name: str) -> bool:
    return ignore_missing(sm.describe_endpoint, EndpointName=name)


def endpoint_instance_type(sm, endpoint_name: str) -> str | None:
    try:
        config_name = sm.describe_endpoint(EndpointName=endpoint_name)["EndpointConfigName"]
        config = sm.describe_endpoint_config(EndpointConfigName=config_name)
        return config["ProductionVariants"][0]["InstanceType"]
    except ClientError as err:
        if is_not_found(err):
            return None
        raise


# ── Model ────────────────────────────────────────────────────────────────────
def create_model(sm, name: str, role_arn: str, image_uri: str, s3_uri: str, environment: dict) -> None:
    try:
        sm.create_model(
            ModelName=name,
            ExecutionRoleArn=role_arn,
            PrimaryContainer={
                "Image": image_uri,
                "ModelDataSource": {"S3DataSource": {
                    "S3Uri": s3_uri, "S3DataType": "S3Prefix", "CompressionType": "None"}},
                "Environment": environment,
            },
        )
    except ClientError as err:
        raise DeployError(f"create-model failed (role trust? S3 read on the bucket?): {error_message(err)}") from err
    info(f"model created: {name}")


def verify_model_environment(sm, name: str, expected: dict) -> None:
    """Re-reads the model and refuses to continue if a crash-critical setting didn't land."""
    actual = sm.describe_model(ModelName=name)["PrimaryContainer"].get("Environment", {})
    for key, value in expected.items():
        got = actual.get(key)
        if got != value:
            raise DeployError(f"{key} reads '{got or '<unset>'}', expected '{value}' — refusing to continue.")
        ok(f"{key} confirmed: {got}")


# ── Endpoint config ──────────────────────────────────────────────────────────
def create_endpoint_config(sm, name: str, variant: dict, reservation: dict | None,
                           reservation_optional: bool) -> None:
    """Creates the config, with the capacity reservation when one is set (falling back if allowed)."""
    if reservation:
        try:
            sm.create_endpoint_config(EndpointConfigName=name,
                                      ProductionVariants=[{**variant, "CapacityReservationConfig": reservation}])
            confirm_reservation(sm, name, reservation.get("MlReservationArn"), reservation_optional)
            info(f"endpoint config created: {name}")
            return
        except ClientError as err:
            if reservation.get("MlReservationArn") and not reservation_optional:
                raise DeployError(f"config with reservation REJECTED: {error_message(err)}") from err
            warn(f"reservation rejected ({error_message(err)}) - falling back to ON-DEMAND")
    sm.create_endpoint_config(EndpointConfigName=name, ProductionVariants=[variant])
    info(f"endpoint config created: {name}")


def confirm_reservation(sm, config_name: str, expected_arn: str | None, optional: bool) -> None:
    if not expected_arn:
        return
    variant = sm.describe_endpoint_config(EndpointConfigName=config_name)["ProductionVariants"][0]
    got = variant.get("CapacityReservationConfig", {}).get("MlReservationArn")
    if got == expected_arn:
        ok(f"reservation CONFIRMED: {got}")
        return
    warn(f"describe-endpoint-config returned '{got or '<empty>'}' - NOT your ARN.")
    if not optional:
        raise DeployError("reservation did not land (set RESERVATION_OPTIONAL=1 to continue on-demand)")


# ── Capacity slot ────────────────────────────────────────────────────────────
def endpoints_on_instance_type(sm, instance_type: str) -> list[str]:
    """Endpoints currently holding `instance_type` capacity (the quota is usually 1)."""
    holders = []
    for endpoint in paginate(sm, "list_endpoints", "Endpoints"):
        name = endpoint["EndpointName"]
        if endpoint_instance_type(sm, name) == instance_type:
            info(f"   . {name}  ({instance_type}, {endpoint['EndpointStatus']})")
            holders.append(name)
    return holders


def free_capacity_slot(sm, instance_type: str, force: bool, settle_secs: int) -> float | None:
    """Deletes endpoints holding the instance type, after confirmation.

    Returns the time the deletes started (to report the capacity gap), or None if the slot was free.
    """
    info(f"checking for endpoints occupying {instance_type}...")
    holders = endpoints_on_instance_type(sm, instance_type)
    if not holders:
        info("   none - capacity slot is free.")
        return None

    info("")
    info(f"WARNING: these endpoints hold {instance_type} capacity (quota is usually 1):")
    for name in holders:
        info(f"      {name}")
    info("")
    if force:
        info("    FORCE_DELETE=1 - deleting without prompting.")
    elif not is_interactive():
        raise DeployError("non-interactive shell. Re-run with FORCE_DELETE=1, or delete them manually.")
    elif not confirm("Delete them and continue?"):
        raise DeployError("aborted - nothing deleted.")

    started = time.time()
    for name in holders:
        info(f"    deleting {name}...")
        ignore_missing(sm.delete_endpoint, EndpointName=name)
    wait_until_deleted(sm, holders, timeout_secs=450)
    info(f"    gone after {time.time() - started:.0f}s")

    if settle_secs > 0:
        info(f"    letting the account quota counter settle ({settle_secs}s)")
        # Deliberate pause: SageMaker's account quota counter lags behind the delete.
        time.sleep(settle_secs)  # nosemgrep: arbitrary-sleep
    return started


def wait_until_deleted(sm, endpoint_names: list[str], timeout_secs: int) -> None:
    print(f"    {now()} waiting for the endpoints to disappear", end="", flush=True)
    deadline = time.time() + timeout_secs
    while any(endpoint_exists(sm, name) for name in endpoint_names):
        if time.time() > deadline:
            info("")
            raise DeployError(f"still present after {timeout_secs // 60} min "
                              "(SageMaker refuses to delete an endpoint that is still Creating).")
        print(".", end="", flush=True)
        # Polling for the endpoint delete to finish.
        time.sleep(5)  # nosemgrep: arbitrary-sleep
    info("")


# ── Endpoint ─────────────────────────────────────────────────────────────────
def wait_for_endpoint(sm, name: str) -> tuple[str, str]:
    """Polls every minute until InService or Failed. Returns (status, failure reason)."""
    while True:
        endpoint = sm.describe_endpoint(EndpointName=name)
        status = endpoint["EndpointStatus"]
        info(f"  {now()} endpoint={status}")
        if status in ("InService", "Failed"):
            return status, endpoint.get("FailureReason", "")
        # Endpoint creation takes 25-40 min: poll once a minute.
        time.sleep(60)  # nosemgrep: arbitrary-sleep


def create_endpoint_with_retry(sm, name: str, config_name: str, retries: int, wait_secs: int,
                               failure_hints: list[str]) -> None:
    """Creates the endpoint, retrying only on capacity/quota errors (rejection or failed boot)."""
    for attempt in range(retries + 1):
        if attempt > 0:
            info(f"    capacity not available yet — waiting {wait_secs // 60} min (attempt {attempt}/{retries})")
            # Deliberate wait before retrying a capacity/quota error.
            time.sleep(wait_secs)  # nosemgrep: arbitrary-sleep
            if endpoint_exists(sm, name):
                ignore_missing(sm.delete_endpoint, EndpointName=name)
                wait_until_deleted(sm, [name], timeout_secs=300)

        try:
            sm.create_endpoint(EndpointName=name, EndpointConfigName=config_name)
        except ClientError as err:
            message = error_message(err)
            info(f"✗ create-endpoint rejected: {message}")
            if QUOTA_REJECTION.search(message):
                continue
            raise DeployError("not a capacity error — not retrying.") from err

        info(f"{now()} endpoint creating (attempt {attempt + 1}/{retries + 1}; ~25-40 min)...")
        status, reason = wait_for_endpoint(sm, name)
        if status == "InService":
            return
        warn(f"Failed: {reason}")
        if not CAPACITY_FAILURE.search(reason):
            for hint in failure_hints:
                info(f"  {hint}")
            raise DeployError("non-capacity failure - not retrying.")

    raise DeployError(f"gave up after {retries + 1} attempts - no capacity. Re-run later.")


# ── Cleanup / teardown ───────────────────────────────────────────────────────
def delete_old_versions(sm, model_name: str, keep_model: str | None = None, keep_config: str | None = None,
                        include_unstamped: bool = False) -> None:
    """Deletes the timestamped models/configs of earlier deploys.

    include_unstamped also removes the plain `<model>` / `<model>-cfg` pair from older script versions
    (only done once their endpoint is known to be gone).
    """
    stamp = r"\d{8}-\d{6}"   # the suffix deploy() adds, so only this script's own resources match
    for model in paginate(sm, "list_models", "Models", NameContains=f"{model_name}-"):
        name = model["ModelName"]
        if re.fullmatch(f"{re.escape(model_name)}-{stamp}", name) and name != keep_model \
                and ignore_missing(sm.delete_model, ModelName=name):
            info(f"  model deleted: {name}")
    for config in paginate(sm, "list_endpoint_configs", "EndpointConfigs", NameContains=f"{model_name}-cfg-"):
        name = config["EndpointConfigName"]
        if re.fullmatch(f"{re.escape(model_name)}-cfg-{stamp}", name) and name != keep_config \
                and ignore_missing(sm.delete_endpoint_config, EndpointConfigName=name):
            info(f"  config deleted: {name}")
    if include_unstamped:
        if ignore_missing(sm.delete_endpoint_config, EndpointConfigName=f"{model_name}-cfg"):
            info(f"  config deleted: {model_name}-cfg")
        if ignore_missing(sm.delete_model, ModelName=model_name):
            info(f"  model deleted: {model_name}")


def teardown(sm, endpoint_name: str, model_name: str) -> None:
    info(f"Tearing down {endpoint_name}...")
    if ignore_missing(sm.delete_endpoint, EndpointName=endpoint_name):
        wait_until_deleted(sm, [endpoint_name], timeout_secs=450)
        info("  endpoint deleted")
    else:
        info("  (no endpoint)")
    delete_old_versions(sm, model_name, include_unstamped=True)
    info("  (S3 weights kept - re-run deploy to bring it back)")


# ── Settings ─────────────────────────────────────────────────────────────────
def env(name: str, default: str = "") -> str:
    """Env var, falling back to `default` when unset OR empty (bash ${VAR:-default})."""
    return os.environ.get(name) or default


def env_keep_empty(name: str, default: str) -> str:
    """Env var where an explicit empty value means "off" (bash ${VAR-default}), e.g. QUANTIZATION=."""
    return os.environ.get(name, default)


def env_int(name: str, default: int) -> int:
    return int(env(name, str(default)))


def env_flag(name: str) -> bool:
    return env(name, "0") == "1"


@dataclass
class Settings:
    region: str
    profile: str | None
    exec_role: str
    dry_run: bool = False

    hf_repo: str = field(default_factory=lambda: env("HF_REPO", "Qwen/Qwen3.8-27B"))
    instance_type: str = field(default_factory=lambda: env("INSTANCE_TYPE", "ml.g6e.2xlarge"))
    endpoint_name: str = field(default_factory=lambda: env("ENDPOINT_NAME", "qwen38-2xl-27b-fp8"))
    model_name: str = field(default_factory=lambda: env("MODEL_NAME", "qwen38-2xl-27b-fp8"))
    bucket: str = field(default_factory=lambda: env("BUCKET"))       # derived from account if empty
    s3_prefix: str = field(default_factory=lambda: env("S3_PREFIX"))  # derived from repo if empty
    expected_shards: int = field(default_factory=lambda: env_int("N_SHARDS", 18))

    # vLLM serving
    tensor_parallel_size: str = field(default_factory=lambda: env("TENSOR_PARALLEL_SIZE", "1"))
    max_model_len: str = field(default_factory=lambda: env("MAX_MODEL_LEN", "131072"))
    max_num_seqs: str = field(default_factory=lambda: env("MAX_NUM_SEQS", "8"))  # few slots: ~10 GB KV + mamba state
    gpu_memory_utilization: str = field(default_factory=lambda: env("GPU_MEMORY_UTILIZATION", "0.92"))
    kv_cache_dtype: str = field(default_factory=lambda: env("KV_CACHE_DTYPE", "fp8_e4m3"))  # never on Ampere
    mamba_cache_mode: str = field(default_factory=lambda: env("MAMBA_CACHE_MODE", "align"))
    max_num_batched_tokens: str = field(default_factory=lambda: env("MAX_NUM_BATCHED_TOKENS", "4096"))
    quantization: str = field(default_factory=lambda: env_keep_empty("QUANTIZATION", "fp8"))
    limit_mm_per_prompt: str = field(default_factory=lambda: env("LIMIT_MM_PER_PROMPT", '{"image": 2, "video": 0}'))
    mm_processor_cache_gb: str = field(default_factory=lambda: env("MM_PROCESSOR_CACHE_GB", "2"))  # 64 GB host RAM
    # The chat template emits Qwen3 XML tool calls and <think> blocks.
    tool_call_parser: str = field(default_factory=lambda: env_keep_empty("TOOL_CALL_PARSER", "qwen3_xml"))
    reasoning_parser: str = field(default_factory=lambda: env_keep_empty("REASONING_PARSER", "qwen3"))
    # Optional MTP speculative decoding, UNTESTED on this DLC, e.g. '{"method":"mtp","num_speculative_tokens":3}'
    speculative_config: str = field(default_factory=lambda: env("SPECULATIVE_CONFIG"))

    # Container + instance
    vllm_version: str = field(default_factory=lambda: env("VLLM_VERSION", "0.26.0"))
    vllm_cuda_tag: str = field(default_factory=lambda: env("VLLM_CUDA_TAG", "cu130"))
    image_uri: str = field(default_factory=lambda: env("IMAGE_URI"))  # derived from region if empty
    inference_ami_version: str = field(
        default_factory=lambda: env("INFERENCE_AMI_VERSION", "al2023-ami-sagemaker-inference-gpu-4-1"))
    startup_health_timeout: int = field(default_factory=lambda: env_int("STARTUP_HEALTH_TIMEOUT", 3600))
    model_download_timeout: int = field(default_factory=lambda: env_int("MODEL_DOWNLOAD_TIMEOUT", 3600))
    allow_any_instance: bool = field(default_factory=lambda: env_flag("ALLOW_ANY_INSTANCE"))

    # Capacity
    capacity_retries: int = field(default_factory=lambda: env_int("CAPACITY_RETRIES", 3))
    capacity_wait_secs: int = field(default_factory=lambda: env_int("CAPACITY_WAIT_SECS", 120))
    ml_reservation_arn: str = field(default_factory=lambda: env("ML_RESERVATION_ARN"))
    capacity_reservation_preference: str = field(default_factory=lambda: env("CAPACITY_RESERVATION_PREFERENCE"))
    reservation_optional: bool = field(default_factory=lambda: env_flag("RESERVATION_OPTIONAL"))
    reservation_warn_secs: int = field(default_factory=lambda: env_int("RESERVATION_WARN_SECS", 30))
    force_delete: bool = field(default_factory=lambda: env_flag("FORCE_DELETE"))
    quota_settle_secs: int = field(default_factory=lambda: env_int("QUOTA_SETTLE_SECS", 20))

    def __post_init__(self):
        if not self.s3_prefix:
            self.s3_prefix = "models/" + self.hf_repo.replace("/", "--")
        if not self.image_uri:
            self.image_uri = (f"763104351884.dkr.ecr.{self.region}.amazonaws.com/vllm:{self.vllm_version}"
                              f"-gpu-py312-{self.vllm_cuda_tag}-ubuntu22.04-sagemaker")
        if self.capacity_reservation_preference == "capacity-reservations-only":
            self.capacity_retries = env_int("CAPACITY_RETRIES_RESERVED", 1)

    @property
    def s3_uri(self) -> str:
        return f"s3://{self.bucket}/{self.s3_prefix}/"

    @property
    def has_reservation(self) -> bool:
        return bool(self.ml_reservation_arn or self.capacity_reservation_preference)


# ── AWS session (profiles, SSO, env keys, roles) ─────────────────────────────
def open_session(settings: Settings) -> tuple[boto3.Session, str]:
    """Returns (session, account id), with a clear message when credentials or the SSO login are stale."""
    login_hint = f"aws sso login --profile {settings.profile}" if settings.profile else "aws sso login"
    try:
        session = boto3.Session(profile_name=settings.profile, region_name=settings.region)
        account_id = session.client("sts").get_caller_identity()["Account"]
    except (BotoCoreError, ClientError) as err:
        raise DeployError(f"AWS credentials not usable: {err}\n"
                          f"  Using SSO? Refresh the login with:  {login_hint}") from err
    who = f"profile {settings.profile}" if settings.profile else "default credential chain"
    info(f"AWS account {account_id} ({who}), region {settings.region}")
    return session, account_id


def require_recent_boto3(sm) -> None:
    variant = (sm.meta.service_model.operation_model("CreateEndpointConfig")
               .input_shape.members["ProductionVariants"].member.members)
    missing = [name for name in VARIANT_FIELDS_NEEDED if name not in variant]
    if missing:
        raise DeployError(f"boto3 {boto3.__version__} is too old (no {', '.join(missing)}). "
                          "python3 -m pip install --upgrade boto3")


def infra_hint(region: str) -> str:
    return (f"The self-hosting stack is not deployed in {region}. Deploy it once (optional, per Region):\n"
            f"      cd {STACK_DIR} && npm install && AWS_REGION={region} npx cdk deploy")


def resolve_exec_role(session: boto3.Session, role: str, account_id: str, region: str) -> str:
    """Accepts a role ARN or name (default: the role the CDK stack creates) and checks that it exists."""
    arn = role if role.startswith("arn:") else f"arn:aws:iam::{account_id}:role/{role}"
    name = arn.rsplit("/", 1)[-1]
    try:
        session.client("iam").get_role(RoleName=name)
    except ClientError as err:
        code = err.response.get("Error", {}).get("Code", "")
        if code == "NoSuchEntity":
            hint = (infra_hint(region) if role == DEFAULT_EXEC_ROLE
                    else "Check the name, or pass --exec-role <name-or-arn>.")
            raise DeployError(f"execution role {name} does not exist.\n  {hint}") from err
        warn(f"could not check execution role {name} ({code}) - continuing")  # e.g. no iam:GetRole permission
    return arn


# ── Preflight ────────────────────────────────────────────────────────────────
def check_instance_supports_fp8(settings: Settings) -> None:
    if settings.instance_type.startswith(FP8_INSTANCE_PREFIXES):
        return
    if not settings.allow_any_instance:
        raise DeployError(
            f"this recipe uses fp8 KV + fp8 weights, which need an Ada/Hopper GPU; {settings.instance_type} "
            "may not have one. For Ampere, use bf16 and override the guard:\n"
            f"    ALLOW_ANY_INSTANCE=1 KV_CACHE_DTYPE=auto QUANTIZATION= INSTANCE_TYPE={settings.instance_type} "
            f"{sys.argv[0]} deploy")
    warn("ALLOW_ANY_INSTANCE=1 — on Ampere you MUST also set KV_CACHE_DTYPE=auto and QUANTIZATION= (bf16).")


def check_weights_staged(s3, settings: Settings) -> str:
    """Verifies shards, vision configs and a chat template are in S3. Returns where the template is."""
    prefix = f"{settings.s3_prefix}/"
    files = set()
    try:
        for page in s3.get_paginator("list_objects_v2").paginate(Bucket=settings.bucket, Prefix=prefix, Delimiter="/"):
            files.update(obj["Key"][len(prefix):] for obj in page.get("Contents", []))
    except ClientError as err:
        if err.response.get("Error", {}).get("Code") != "NoSuchBucket":
            raise
        raise DeployError(f"weights bucket {settings.bucket} does not exist.\n  {infra_hint(settings.region)}") from err

    shards = sum(1 for name in files if name.endswith(".safetensors"))
    if shards < settings.expected_shards:
        raise DeployError(f"only {shards}/{settings.expected_shards} safetensors at {settings.s3_uri}\n"
                          f"  stage first:  AWS_REGION={settings.region} ./scripts/stage_qwen38_ec2.sh")
    for required in REQUIRED_FILES:
        if required not in files:
            raise DeployError(f"missing {settings.s3_uri}{required} — staging is incomplete or still running.\n"
                              f"  check:  AWS_REGION={settings.region} ./scripts/stage_qwen38_ec2.sh --verify")

    template = next((name for name in ("chat_template.jinja", "chat_template.json") if name in files), None)
    if not template and "tokenizer_config.json" in files:
        body = s3.get_object(Bucket=settings.bucket, Key=prefix + "tokenizer_config.json")["Body"].read()
        template = "inline in tokenizer_config.json" if b'"chat_template"' in body else None
    if not template:
        raise DeployError(f"no chat template found at {settings.s3_uri}")
    info(f"preflight ok: {shards}/{settings.expected_shards} shards + multimodal configs (template: {template})")
    return template


def check_gpu_quota(session: boto3.Session, settings: Settings) -> None:
    """Stops before anything is created or deleted when the account has no quota for the instance type."""
    wanted = f"{settings.instance_type} for endpoint usage"
    try:
        pages = session.client("service-quotas").get_paginator("list_service_quotas").paginate(ServiceCode="sagemaker")
        quotas = [q for page in pages for q in page["Quotas"] if q["QuotaName"] == wanted]
    except (BotoCoreError, ClientError) as err:
        warn(f"could not check the '{wanted}' quota ({err}) - continuing")
        return
    if not quotas:
        warn(f"no '{wanted}' quota found - continuing")
        return
    if quotas[0]["Value"] < 1:
        raise DeployError(
            f"quota '{wanted}' is {quotas[0]['Value']:g} in {settings.region}; request an increase (it can take a while):\n"
            f"    aws service-quotas request-service-quota-increase --service-code sagemaker "
            f"--quota-code {quotas[0]['QuotaCode']} --desired-value 1 --region {settings.region}")
    info(f"quota ok: {wanted} = {quotas[0]['Value']:g}")


def warn_if_on_demand(settings: Settings) -> None:
    if settings.has_reservation or settings.dry_run:
        return
    price = APPROX_PRICE.get(settings.instance_type, "on-demand rate")
    info("")
    warn(f"NO ML-RESERVATION SET - DEPLOYING ON-DEMAND ({price} for {settings.instance_type})")
    countdown(settings.reservation_warn_secs, "Continuing on-demand")
    info("")


# ── What gets created ────────────────────────────────────────────────────────
def container_environment(settings: Settings) -> dict:
    """vLLM settings for the SageMaker DLC (SM_VLLM_* map to vLLM CLI flags)."""
    environment = {
        "SM_VLLM_MODEL": "/opt/ml/model",
        "SM_VLLM_TENSOR_PARALLEL_SIZE": settings.tensor_parallel_size,
        "SM_VLLM_MAX_MODEL_LEN": settings.max_model_len,
        "SM_VLLM_MAX_NUM_SEQS": settings.max_num_seqs,
        "SM_VLLM_MAX_NUM_BATCHED_TOKENS": settings.max_num_batched_tokens,
        "SM_VLLM_GPU_MEMORY_UTILIZATION": settings.gpu_memory_utilization,
        "SM_VLLM_KV_CACHE_DTYPE": settings.kv_cache_dtype,
        "SM_VLLM_MAMBA_CACHE_MODE": settings.mamba_cache_mode,
        "SM_VLLM_LIMIT_MM_PER_PROMPT": settings.limit_mm_per_prompt,
        "SM_VLLM_MM_PROCESSOR_CACHE_GB": settings.mm_processor_cache_gb,
        "SM_VLLM_ENABLE_CHUNKED_PREFILL": "true",
    }
    # Optional flags are set ONLY when non-empty: an empty value becomes a bare flag and breaks argparse.
    if settings.quantization:
        environment["SM_VLLM_QUANTIZATION"] = settings.quantization
    if settings.tool_call_parser:
        environment["SM_VLLM_ENABLE_AUTO_TOOL_CHOICE"] = "true"
        environment["SM_VLLM_TOOL_CALL_PARSER"] = settings.tool_call_parser
    if settings.reasoning_parser:
        environment["SM_VLLM_REASONING_PARSER"] = settings.reasoning_parser
    if settings.speculative_config:
        environment["SM_VLLM_SPECULATIVE_CONFIG"] = settings.speculative_config
    return environment


def settings_to_verify(environment: dict) -> dict:
    """The settings whose absence crashes or silently degrades the deploy."""
    keys = ("SM_VLLM_MAMBA_CACHE_MODE", "SM_VLLM_QUANTIZATION",
            "SM_VLLM_TOOL_CALL_PARSER", "SM_VLLM_ENABLE_AUTO_TOOL_CHOICE")
    return {key: environment[key] for key in keys if key in environment}


def production_variant(settings: Settings, model_name: str) -> dict:
    return {
        "VariantName": "primary",
        "ModelName": model_name,
        "InstanceType": settings.instance_type,
        "InitialInstanceCount": 1,
        "ContainerStartupHealthCheckTimeoutInSeconds": settings.startup_health_timeout,
        "ModelDataDownloadTimeoutInSeconds": settings.model_download_timeout,
        "InferenceAmiVersion": settings.inference_ami_version,
    }


def reservation_config(settings: Settings) -> dict | None:
    if not settings.has_reservation:
        return None
    config = {}
    if settings.capacity_reservation_preference:
        config["CapacityReservationPreference"] = settings.capacity_reservation_preference
    if settings.ml_reservation_arn:
        config["MlReservationArn"] = settings.ml_reservation_arn
    return config


def print_plan(settings: Settings, environment: dict) -> None:
    banner(
        f"QWEN3.8-27B (bf16 -> fp8 dynamic, hybrid+vision) -> vLLM {settings.vllm_version}",
        f"  {settings.instance_type}  region={settings.region}  endpoint={settings.endpoint_name}",
        f"  weights: {settings.s3_uri}  (~56 GB bf16)",
        f"  image:   {settings.image_uri}",
        f"  AMI:     {settings.inference_ami_version}  (required for cu130)",
        f"  TP={settings.tensor_parallel_size}  max_len={settings.max_model_len}  "
        f"max_seqs={settings.max_num_seqs}  gpu_util={settings.gpu_memory_utilization}",
        f"  kv_cache={settings.kv_cache_dtype}  quantization={settings.quantization or '<none: bf16>'}  "
        f"mamba_cache_mode={settings.mamba_cache_mode}",
        f"  images/prompt: {settings.limit_mm_per_prompt}   trust_remote_code=NO",
        f"  tool_parser={settings.tool_call_parser or '<off>'}  reasoning_parser={settings.reasoning_parser or '<off>'}"
        f"  mtp={settings.speculative_config or '<off>'}",
        *([f"  reservation: {settings.ml_reservation_arn}"] if settings.ml_reservation_arn else []),
    )
    if settings.dry_run:
        info("container environment:")
        for key, value in environment.items():
            info(f"    {key}={value}")


# ── Commands ─────────────────────────────────────────────────────────────────
def deploy(settings: Settings) -> None:
    session, account_id = open_session(settings)
    sm, s3 = session.client("sagemaker"), session.client("s3")
    require_recent_boto3(sm)
    settings.bucket = settings.bucket or f"sagemaker-qwen38-vllm-{account_id}-{settings.region}"

    role_arn = resolve_exec_role(session, settings.exec_role, account_id, settings.region)
    info(f"execution role: {role_arn}")
    check_instance_supports_fp8(settings)
    check_weights_staged(s3, settings)
    check_gpu_quota(session, settings)
    warn_if_on_demand(settings)

    environment = container_environment(settings)
    print_plan(settings, environment)

    if settings.dry_run:
        info("checking for endpoints occupying the capacity slot (read-only)...")
        holders = endpoints_on_instance_type(sm, settings.instance_type)
        info(f"dry run: would delete {', '.join(holders)} first" if holders else "   none - capacity slot is free.")
        ok("dry run complete - nothing was created or deleted.")
        return

    stamp = time.strftime("%Y%m%d-%H%M%S")
    model_name, config_name = f"{settings.model_name}-{stamp}", f"{settings.model_name}-cfg-{stamp}"

    create_model(sm, model_name, role_arn, settings.image_uri, settings.s3_uri, environment)
    verify_model_environment(sm, model_name, settings_to_verify(environment))
    create_endpoint_config(sm, config_name, production_variant(settings, model_name),
                               reservation_config(settings), settings.reservation_optional)

    freed_at = free_capacity_slot(sm, settings.instance_type, settings.force_delete, settings.quota_settle_secs)
    create_endpoint_with_retry(
        sm, settings.endpoint_name, config_name, settings.capacity_retries, settings.capacity_wait_secs,
        failure_hints=[
            f"Read the boot log in CloudWatch: /aws/sagemaker/Endpoints/{settings.endpoint_name}",
            f"fp8 error for a module? Retry bf16:  QUANTIZATION= KV_CACHE_DTYPE=auto {sys.argv[0]} deploy",
            "NotImplementedError about 'all' prefix caching? mamba_cache_mode did not reach the server.",
        ])
    if freed_at:
        info(f"    ⏱️  {time.time() - freed_at:.0f}s from freeing the slot to InService")

    delete_old_versions(sm, settings.model_name, keep_model=model_name, keep_config=config_name,
                            include_unstamped=freed_at is not None)

    ok(f"'{settings.endpoint_name}' is InService in {settings.region}.")
    print_test_commands(settings)
    info("")
    info("Confirm in the boot log: kv_cache_dtype=fp8, quantization=fp8")
    info(f"  /aws/sagemaker/Endpoints/{settings.endpoint_name}")
    warn(f"Billing while InService. Tear down:  {sys.argv[0]} delete")


def print_test_commands(settings: Settings) -> None:
    """Testing is one request. SageMaker only accepts signed requests, so the direct call is the AWS CLI."""
    body = ('{"messages":[{"role":"user","content":"Say hi in one short sentence."}],'
            '"max_tokens":64,"chat_template_kwargs":{"enable_thinking":false}}')
    info("")
    info("Test it directly (the AWS CLI signs the request with your profile / SSO login):")
    info(f"  aws sagemaker-runtime invoke-endpoint --region {settings.region} --endpoint-name {settings.endpoint_name} \\")
    info("    --content-type application/json --cli-binary-format raw-in-base64-out \\")
    info(f"    --body '{body}' /dev/stdout")
    info("or through the gateway, once the route is added (README, step 4):")
    info('  curl -s $GATEWAY_URL/v1/chat/completions -H "Authorization: Bearer $KEY" \\')
    info(f"    -H 'Content-Type: application/json' -d '{{\"model\":\"{settings.endpoint_name}\","
         "\"messages\":[{\"role\":\"user\",\"content\":\"Say hi\"}],\"max_tokens\":64}'")


def delete(settings: Settings) -> None:
    session, _ = open_session(settings)
    if settings.dry_run:
        info(f"dry run: would delete endpoint {settings.endpoint_name} and models/configs named "
             f"{settings.model_name}-*")
        return
    teardown(session.client("sagemaker"), settings.endpoint_name, settings.model_name)


# ── CLI ──────────────────────────────────────────────────────────────────────
def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Deploy or delete the Qwen3.8-27B SageMaker endpoint.",
        epilog="All vLLM and capacity knobs are environment variables; see the docstring at the top of this file.")
    parser.add_argument("command", choices=("deploy", "delete"))
    parser.add_argument("--region", default=env("AWS_REGION", env("SAGEMAKER_REGION", "eu-north-1")),
                        help="AWS region (default: $AWS_REGION, else eu-north-1)")
    parser.add_argument("--profile", default=env("AWS_PROFILE") or None,
                        help="AWS profile, incl. SSO profiles (default: $AWS_PROFILE / default chain)")
    parser.add_argument("--exec-role", default=env("SM_EXEC_ROLE", env("SAGEMAKER_ROLE_ARN", DEFAULT_EXEC_ROLE)),
                        help=f"SageMaker execution role, name or ARN (default: {DEFAULT_EXEC_ROLE}, from the stack)")
    parser.add_argument("--dry-run", action="store_true",
                        help="run the read-only checks and print the plan; create or delete nothing")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    settings = Settings(region=args.region, profile=args.profile, exec_role=args.exec_role, dry_run=args.dry_run)
    commands = {"deploy": deploy, "delete": delete}
    try:
        commands[args.command](settings)
    except DeployError as err:
        print(f"✗ {err}", file=sys.stderr)
        sys.exit(1)
    except (BotoCoreError, ClientError) as err:
        login = f"aws sso login --profile {settings.profile}" if settings.profile else "aws sso login"
        print(f"✗ AWS error: {err}\n  Expired SSO login? Run:  {login}\n"
              f"  An endpoint that was already created keeps billing. Check or remove it:  {sys.argv[0]} delete",
              file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n✗ interrupted. An endpoint that was already created keeps running and billing: "
              f"{sys.argv[0]} delete removes it.", file=sys.stderr)
        sys.exit(130)


if __name__ == "__main__":
    main()
