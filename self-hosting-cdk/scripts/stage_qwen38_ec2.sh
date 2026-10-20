#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# =============================================================================
# Stage Qwen3.8-27B (bf16, hybrid linear-attn + vision) HF -> S3 via a THROWAWAY EC2
# =============================================================================
# WHAT THIS IS — Qwen/Qwen3.8-27B (Apache-2.0, not gated). model_type qwen3_5, hybrid
# (16/64 full-attention, 48 linear-attn) + vision tower + 1 MTP layer.
#
# ⚠️ UNQUANTIZED. The repo is bf16 (51.75 GiB, 18 safetensors), so we stage bf16 and the deploy
#    quantizes to fp8 at load (L40S has native fp8).
#
# NO ACCOUNT OR TOKEN NEEDED. Qwen/Qwen3.8-27B is public (Apache-2.0, not gated), so the download is
#    anonymous. (A gated repo is not supported by this script.)
#
# SETUP. Needs the CDK stack in this folder (weights bucket + the staging role), deployed once per
#    Region. This script creates no buckets and no IAM: it checks the stack is there and prints the
#    command to deploy it if not.
#
# WHY EC2 — one HF CDN stream caps ~1.9 MB/s locally; in-region it's HF -> EC2 (multi-Gbps) -> S3,
#   ~55 GB in a few minutes, and the box self-terminates.
#
# USAGE
#   AWS_REGION=eu-north-1 ./scripts/stage_qwen38_ec2.sh           # launch + poll   (from self-hosting-cdk/)
#   AWS_REGION=eu-north-1 ./scripts/stage_qwen38_ec2.sh --watch   # re-attach to a running builder
#   AWS_REGION=eu-north-1 ./scripts/stage_qwen38_ec2.sh --kill    # terminate the builder
#   AWS_REGION=eu-north-1 ./scripts/stage_qwen38_ec2.sh --verify  # check S3 only
# =============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Shared settings (the bucket name must match the CDK stack and deploy_qwen38.py) ──────────────
AWS_REGION="${AWS_REGION:-${SAGEMAKER_REGION:-eu-north-1}}"
HF_REPO="${HF_REPO:-Qwen/Qwen3.8-27B}"

# Expected checkpoint shape: bf16, 51.75 GiB across 18 safetensors.
EXPECTED_SHARDS="${EXPECTED_SHARDS:-${N_SHARDS:-18}}"
# GiB as measured by `du` / S3 totals — gate below the 51.75 GiB figure, not the 55.56 GB nominal one.
EXPECTED_GB="${EXPECTED_GB:-49}"
# Files a vision model will not load without (weights alone are not enough).
REQUIRED_CONFIGS=(config.json preprocessor_config.json chat_template.jinja model.safetensors.index.json
                  tokenizer.json tokenizer_config.json vocab.json merges.txt)

# ── Output ───────────────────────────────────────────────────────────────────
info() { echo "$*"; }
ok()   { echo "✅ $*"; }
warn() { echo "⚠  $*"; }
die()  { echo "✗ $*" >&2; exit 1; }
banner() {
  echo "════════════════════════════════════════════════════════════════"
  printf ' %s\n' "$@"
  echo "════════════════════════════════════════════════════════════════"
}

# ── AWS context and S3 helpers ───────────────────────────────────────────────
# The AWS CLI honours AWS_PROFILE (incl. IAM Identity Center / SSO profiles) and env-var keys.
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)" \
  || die "AWS credentials not usable. Using SSO? Run: aws sso login${AWS_PROFILE:+ --profile $AWS_PROFILE}"
# Bucket name: sagemaker-qwen38-vllm-<account>-<region>. It must match the CDK stack and deploy_qwen38.py.
BUCKET="${BUCKET:-sagemaker-qwen38-vllm-${ACCOUNT_ID}-${AWS_REGION}}"
S3_PREFIX="${S3_PREFIX:-models/${HF_REPO//\//--}}"
S3_MODEL_URI="s3://${BUCKET}/${S3_PREFIX}/"

s3_has_file() {
  aws s3 ls "${S3_MODEL_URI}$1" --region "$AWS_REGION" >/dev/null 2>&1
}

# Prints "<safetensors count> <total GiB>" for the staged model prefix.
staged_state() {
  local listing count gib
  listing=$(aws s3 ls "$S3_MODEL_URI" --region "$AWS_REGION" --recursive --summarize 2>/dev/null)
  count=$(printf '%s\n' "$listing" | grep -c '\.safetensors$' || true)
  gib=$(printf '%s\n' "$listing" | awk '/Total Size/{printf "%.0f", $3/1073741824}')
  echo "${count:-0} ${gib:-0}"
}

is_fully_staged() {
  local count="$1" gib="$2"
  [ "$count" -ge "$EXPECTED_SHARDS" ] && [ "$gib" -ge "$EXPECTED_GB" ]
}

# Prints the first required file that is not in S3 yet (nothing if all are there).
missing_file() {
  local file
  for file in "${REQUIRED_CONFIGS[@]}"; do
    s3_has_file "$file" || { echo "$file"; return; }
  done
}

# ── Settings ─────────────────────────────────────────────────────────────────
HF_REVISION="${HF_REVISION:-1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0}"   # a commit sha, so every run stages the same files
BUILDER_ROLE="${BUILDER_ROLE:-qwen38-stager-builder}"   # created by the CDK stack (role + instance profile share the name)
BUILDER_INSTANCE_TYPE="${BUILDER_INSTANCE_TYPE:-c7i.4xlarge}"
BUILDER_TAG="${BUILDER_TAG:-qwen38-27b-stager-${AWS_REGION}}"
BUILDER_DISK_GB="${BUILDER_DISK_GB:-120}"                # ~55 GB model + HF cache, with headroom
DEPLOY_HINT="./scripts/deploy_qwen38.py deploy --region $AWS_REGION"

# ── Builder instance ─────────────────────────────────────────────────────────
find_running_builder() {
  aws ec2 describe-instances --region "$AWS_REGION" \
    --filters "Name=tag:Name,Values=${BUILDER_TAG}" "Name=instance-state-name,Values=pending,running" \
    --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null | tr -d '\n'
}

# Prints "<state> <instance-id>" for the most recently launched builder.
latest_builder() {
  aws ec2 describe-instances --region "$AWS_REGION" \
    --filters "Name=tag:Name,Values=${BUILDER_TAG}" \
    --query 'Reservations[].Instances[] | sort_by(@,&LaunchTime)[-1].[State.Name,InstanceId]' \
    --output text || echo "unknown"
}

kill_builder() {
  local id
  id=$(find_running_builder)
  if [ -z "$id" ]; then info "no running builder tagged $BUILDER_TAG in $AWS_REGION"; return; fi
  # shellcheck disable=SC2086  # may be several space-separated IDs
  aws ec2 terminate-instances --region "$AWS_REGION" --instance-ids $id >/dev/null
  info "terminated: $id"
}

# Builder network throughput over the last 5-minute window, e.g. "  net=950 MB/s" (or empty).
network_rate() {
  local id="$1" start bytes
  [ -z "$id" ] || [ "$id" = "None" ] && return
  start=$(date -u -v-10M +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -d '10 min ago' +%Y-%m-%dT%H:%M:%S)
  bytes=$(aws cloudwatch get-metric-statistics --region "$AWS_REGION" --namespace AWS/EC2 \
    --metric-name NetworkIn --dimensions Name=InstanceId,Value="$id" \
    --start-time "$start" --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" --period 300 --statistics Sum \
    --query 'sort_by(Datapoints,&Timestamp)[-1].Sum' --output text 2>/dev/null)
  case "$bytes" in ''|None) ;; *) awk -v b="$bytes" 'BEGIN{printf "  net=%.0f MB/s", b/300/1048576}' ;; esac
}

heartbeat() {
  aws s3 cp "s3://${BUCKET}/${S3_PREFIX}.stager-heartbeat" - --region "$AWS_REGION" 2>/dev/null | tail -1
}

console_hint() {
  info "    Why:  aws s3 cp s3://${BUCKET}/${S3_PREFIX}.stager-heartbeat -    (the last status line the builder wrote)"
  info "          aws ec2 get-console-output --region $AWS_REGION --instance-id $1 --latest --output text | tail -40"
  info "          (the console output is empty once the instance is gone, so the line above is the reliable one)"
  info "    Re-run this script — 'hf download' and 's3 sync' both resume."
}

# Polls until staging completes (0) or the builder dies early (1). Ctrl-C is safe.
poll() {
  local state id count gib beat missing
  info "polling (Ctrl-C is safe — the builder keeps going and self-terminates)..."
  while true; do
    read -r state id <<<"$(latest_builder)"
    read -r count gib <<<"$(staged_state)"
    beat=$(heartbeat)
    info "$(date +%H:%M:%S) builder=$state  safetensors=${count}/${EXPECTED_SHARDS}  ${gib}/52 GiB$(network_rate "$id")"
    [ -n "$beat" ] && info "            ↳ $beat"

    case "$state" in
      terminated|shutting-down|stopped|stopping)
        missing=$(missing_file)
        if is_fully_staged "$count" "$gib" && [ -z "$missing" ] && [[ "$beat" != *FAILED* ]]; then
          ok "staging complete — ${count} safetensors, ${gib} GB, all config files present"
          info "   deploy:  $DEPLOY_HINT"
          return 0
        fi
        warn "builder stopped, but staging is incomplete: ${count} safetensors, ${gib} GB${missing:+, missing $missing}."
        console_hint "$id"
        return 1 ;;
    esac
    if [[ "$beat" == *FAILED* ]]; then
      warn "the builder reported a failure and is shutting down."
      console_hint "$id"
      return 1
    fi
    sleep 60
  done
}

# ── Verification ─────────────────────────────────────────────────────────────
verify_s3() {
  local count gib file
  read -r count gib <<<"$(staged_state)"
  info "${S3_MODEL_URI}  ->  ${count} safetensors, ${gib} GB"
  is_fully_staged "$count" "$gib" \
    || die "incomplete — need >=${EXPECTED_SHARDS} shards and >=${EXPECTED_GB} GB. Run without --verify to stage."
  file=$(missing_file)
  [ -z "$file" ] || die "missing $file — the model will not load without it"
  ok "complete (${EXPECTED_SHARDS} shards + config, tokenizer and vision files present)"
}

# Exits early when there is nothing to do; returns when a builder should be launched.
skip_if_already_staged() {
  local count gib
  read -r count gib <<<"$(staged_state)"
  if is_fully_staged "$count" "$gib" && [ -z "$(missing_file)" ]; then
    ok "already staged: ${count} safetensors, ${gib} GB at ${S3_MODEL_URI}"
    info "   Not launching a builder. To re-stage anyway:  FORCE=1 $0"
    info "   Deploy:  $DEPLOY_HINT"
    [ "${FORCE:-0}" = "1" ] || exit 0
    info "   FORCE=1 set — re-staging."
  fi
  [ "$count" -gt 0 ] && info "ℹ️  partial: ${count}/${EXPECTED_SHARDS} shards, ${gib} GB — s3 sync will resume."
  return 0
}

# ── Infrastructure (created once by the CDK stack) ──────────────────────────────────────────────
# This script does not create buckets or IAM. It only checks that the CDK stack is there, and says
# exactly what to run when it is not. A permission error on the check itself is only a warning:
# the real calls below fail with their own message if something is really missing.
infra_hint() {
  info "  The self-hosting stack is not deployed in $AWS_REGION. Deploy it once (optional, per Region):"
  info "      cd $(cd "$HERE/.." && pwd) && npm install && AWS_REGION=$AWS_REGION npx cdk deploy"
}

require_infra() {
  local out
  if ! out=$(aws s3api head-bucket --bucket "$BUCKET" 2>&1); then
    if grep -qE "404|Not Found|NoSuchBucket" <<<"$out"; then
      warn "bucket $BUCKET does not exist."; infra_hint; exit 1
    fi
    warn "could not check bucket $BUCKET (${out##*: }) - continuing"
  fi
  if ! out=$(aws iam get-instance-profile --instance-profile-name "$BUILDER_ROLE" 2>&1); then
    if grep -q "NoSuchEntity" <<<"$out"; then
      warn "instance profile $BUILDER_ROLE does not exist."; infra_hint; exit 1
    fi
    warn "could not check instance profile $BUILDER_ROLE (${out##*: }) - continuing"
  fi
  info "✓ stack resources found: bucket $BUCKET, instance profile $BUILDER_ROLE"
}

# What the throwaway EC2 runs, as user-data: the settings it needs, then the script below. The script is
# quoted (<<'REMOTE'), so nothing in it is expanded on this machine.
render_userdata() {
  local out="$1"
  {
    echo '#!/bin/bash'
    printf 'export %s=%q\n' \
      AWS_REGION "$AWS_REGION" BUCKET "$BUCKET" S3_PREFIX "$S3_PREFIX" \
      HF_REPO "$HF_REPO" HF_REVISION "$HF_REVISION" \
      EXPECTED_SHARDS "$EXPECTED_SHARDS" EXPECTED_GB "$EXPECTED_GB"
    echo "REQUIRED_CONFIGS=(${REQUIRED_CONFIGS[*]})"
    cat <<'REMOTE'
# Runs on the instance: Hugging Face -> local disk -> S3, then shut down (the instance is launched with
# shutdown-behaviour=terminate, so shutting down terminates it).
set -Eeuxo pipefail
# Log to a file and to the console, so `aws ec2 get-console-output` shows what happened.
exec > >(tee -a /var/log/stager.log /dev/console) 2>&1
# Dead-man's switch: whatever goes wrong, the instance is gone in 4 hours (shutdown terminates it).
shutdown -h +240

MODEL_DIR=/data/model
S3_MODEL_URI="s3://${BUCKET}/${S3_PREFIX}/"
HEARTBEAT_URI="s3://${BUCKET}/${S3_PREFIX}.stager-heartbeat"

# Progress line the local poller shows; failures are reported the same way.
beat() { echo "$(date -u +%FT%TZ) $*" | aws s3 cp - "$HEARTBEAT_URI" 2>/dev/null || true; }
FAIL_MSG=""
fail() { FAIL_MSG="$*"; exit 1; }
trap 'FAIL_MSG="${FAIL_MSG:-command failed near line $LINENO}"' ERR
# On any exit, success or not: report a failure, then shut down so the instance never keeps billing.
on_exit() {
  local rc=$?
  [ "$rc" -eq 0 ] || beat "FAILED: ${FAIL_MSG:-exit $rc}"
  shutdown -h now
}
trap on_exit EXIT

install_tools() {
  local attempt
  for attempt in 1 2 3 4 5; do
    dnf install -y python3-pip tar gzip && break
    beat "dnf retry $attempt"; sleep 20
  done
  pip3 install -q 'huggingface_hub==0.35.3' || fail "pip install"
  aws configure set default.s3.max_concurrent_requests 32
  aws configure set default.s3.multipart_chunksize 128MB
}

download_model() {
  beat "downloading ${HF_REPO} @ ${HF_REVISION} (~56 GB bf16)"
  export HF_XET_HIGH_PERFORMANCE=1   # use all cores and bandwidth of the big instance
  "$(command -v hf || echo /usr/local/bin/hf)" download "$HF_REPO" --revision "$HF_REVISION" \
    --local-dir "$MODEL_DIR" --quiet >/dev/null || fail "hf download"
}

verify_local() {
  local shards gib file
  shards=$(find "$MODEL_DIR" -maxdepth 1 -name '*.safetensors' | wc -l)
  gib=$(du -sB1 "$MODEL_DIR" | awk '{printf "%.0f", $1/1073741824}')
  beat "downloaded $shards safetensors, ${gib} GB"
  if [ "$shards" -lt "$EXPECTED_SHARDS" ] || [ "$gib" -lt "$EXPECTED_GB" ]; then
    fail "expected >=${EXPECTED_SHARDS} safetensors and >=${EXPECTED_GB} GB, got $shards / ${gib} GB"
  fi
  for file in "${REQUIRED_CONFIGS[@]}"; do
    [ -f "$MODEL_DIR/$file" ] || fail "missing $file — a vision model needs its preprocessor config, not just weights"
  done
  beat "vision configs present"
}

upload_model() {
  beat "uploading to s3"
  aws s3 sync "$MODEL_DIR" "$S3_MODEL_URI" --only-show-errors \
    --exclude ".cache/*" --exclude "*/.cache/*" || fail "s3 sync"
}

verify_s3() {
  local listing shards gib file
  listing=$(aws s3 ls "$S3_MODEL_URI" --summarize --recursive)
  gib=$(echo "$listing" | awk '/Total Size/{printf "%.0f", $3/1073741824}')
  shards=$(echo "$listing" | grep -c '\.safetensors$' || true)
  if [ "${gib:-0}" -lt "$EXPECTED_GB" ] || [ "$shards" -lt "$EXPECTED_SHARDS" ]; then
    fail "s3 has only $shards safetensors / ${gib} GB"
  fi
  for file in "${REQUIRED_CONFIGS[@]}"; do
    aws s3 ls "${S3_MODEL_URI}$file" >/dev/null 2>&1 || fail "$file did not reach s3"
  done
  beat "done: $shards safetensors, ${gib} GB in s3 (config, tokenizer and vision files verified)"
}

beat boot
install_tools
download_model
verify_local
upload_model
verify_s3
echo STAGING_DONE
aws s3 rm "$HEARTBEAT_URI" 2>/dev/null || true
# the EXIT trap shuts the instance down
REMOTE
  } > "$out"
}

launch_builder() {
  local ami userdata instance_id disk attempt
  ami=$(aws ssm get-parameter --region "$AWS_REGION" \
    --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
    --query 'Parameter.Value' --output text) || die "could not resolve the AL2023 AMI"
  userdata=$(mktemp "${TMPDIR:-/tmp}/qwen38-userdata.XXXXXX")
  render_userdata "$userdata"
  disk="[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"Encrypted\":true,\"VolumeSize\":${BUILDER_DISK_GB},\"VolumeType\":\"gp3\",\"Throughput\":1000,\"Iops\":6000,\"DeleteOnTermination\":true}}]"

  # Forget a FAILED heartbeat left by an earlier run.
  aws s3 rm "s3://${BUCKET}/${S3_PREFIX}.stager-heartbeat" --region "$AWS_REGION" >/dev/null 2>&1 || true

  # A just-created instance profile can take a few seconds to be usable, so retry that one error.
  for attempt in 1 2 3 4; do
    instance_id=$(aws ec2 run-instances --region "$AWS_REGION" \
      --image-id "$ami" --instance-type "$BUILDER_INSTANCE_TYPE" \
      --iam-instance-profile Name="$BUILDER_ROLE" \
      --instance-initiated-shutdown-behavior terminate \
      --metadata-options HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=2 \
      --block-device-mappings "$disk" \
      --user-data "file://$userdata" \
      --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${BUILDER_TAG}}]" \
      --count 1 --query 'Instances[0].InstanceId' --output text 2>&1) && break
    grep -q "Invalid IAM Instance Profile" <<<"$instance_id" && [ "$attempt" -lt 4 ] \
      || { rm -f "$userdata"; die "run-instances failed: $instance_id"; }
    info "instance profile not ready yet - retrying in 10 s"; sleep 10
  done
  rm -f "$userdata"
  info "✓ builder launched: $instance_id (self-terminates when done)"
  info ""
}

print_plan() {
  banner "STAGE Qwen3.8-27B (bf16, hybrid+vision) via throwaway EC2  (nothing downloads locally)" \
    "  repo    = $HF_REPO  (~56 GB bf16, ${EXPECTED_SHARDS} safetensors + configs)" \
    "  rev     = ${HF_REVISION}" \
    "  region  = $AWS_REGION   builder = $BUILDER_INSTANCE_TYPE / ${BUILDER_DISK_GB} GB" \
    "  dest    → ${S3_MODEL_URI}" \
    "  NOTE    public model, anonymous download; bf16 checkpoint, deploy quantizes to fp8 on the fly"
}

# ── Main ─────────────────────────────────────────────────────────────────────
main() {
  case "${1:-}" in
    --kill)   kill_builder; exit 0 ;;
    --watch)  poll; exit $? ;;
    --verify) verify_s3; exit 0 ;;
  esac

  skip_if_already_staged
  if [ -n "$(find_running_builder)" ]; then
    info "ℹ  builder already running — watching instead of launching another."
    poll; exit $?
  fi

  require_infra
  print_plan
  launch_builder
  poll
}

main "$@"
