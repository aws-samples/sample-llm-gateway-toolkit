# Local gateway

Run LiteLLM and PostgreSQL in Docker to try models and configuration changes locally. Requests to Amazon Bedrock use your AWS credentials and incur normal model charges.

## Requirements

- Docker with Docker Compose.
- Node.js 22 or later.
- AWS credentials with access to the models in [`config.yaml`](config.yaml).

## Start Containers

Open a terminal in `gateway-local/` and run:

```sh
npm start
```

This generates credentials on the first run, starts both containers, and waits until they are ready. Credentials are saved in `.env` and reused on later runs. No `npm install` is needed.

The default AWS profile is used, with `~/.aws` mounted read-only. Set `AWS_PROFILE` in your terminal to choose another; temporary AWS credentials exported there are also supported. You can edit `.env` to save your preferred profile and Region.

## Create a virtual key

Open **[localhost:4000/ui](http://localhost:4000/ui)**. Sign in as `admin`, using the password printed by:

```sh
docker compose exec litellm printenv LITELLM_MASTER_KEY
```

Under **Virtual Keys**, choose **Create New Key**, select your models, and copy the key. Use virtual keys for model requests; keep the master key for administration.

## Send a request

Replace `<virtual-key>` with the key you created:

```sh
curl --fail-with-body http://localhost:4000/v1/chat/completions \
  -H 'Authorization: Bearer <virtual-key>' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "claude-sonnet",
    "messages": [{"role": "user", "content": "Say hello."}]
  }'
```

## Change models

Edit [`config.yaml`](config.yaml), then restart LiteLLM:

```sh
docker compose restart litellm
```

> Each model can specify its own AWS Region with `aws_region_name`.

## Stop

```sh
npm stop
```

Keys and spend history remain in the database volume. To delete that data as well, use `docker compose down --volumes`.
