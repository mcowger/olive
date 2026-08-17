import { spawnSync } from "node:child_process";

const context = process.env.OLIVE_STAGING_DOCKER_CONTEXT ?? "dolphin";
const sshHost = process.env.OLIVE_STAGING_SSH_HOST ?? context;
const stagingUrl = (
  process.env.OLIVE_STAGING_URL ?? "http://192.168.0.2:4470"
).replace(/\/$/, "");
const containerName = process.env.OLIVE_STAGING_CONTAINER_NAME ?? "olive";
const serviceName = process.env.OLIVE_STAGING_SERVICE_NAME ?? "olive";
const imageName = process.env.OLIVE_STAGING_IMAGE_NAME ?? "olive";
const imageRetention = Number.parseInt(
  process.env.OLIVE_STAGING_IMAGE_RETAIN ?? "3",
  10
);
const healthTimeout = Number.parseInt(
  process.env.OLIVE_STAGING_HEALTH_TIMEOUT ?? "60",
  10
);
const targetPlatform =
  process.env.OLIVE_STAGING_TARGET_PLATFORM ?? "linux/amd64";

const buildDate = new Date().toISOString();
const timestamp = buildDate
  .replace(/[-:]/g, "")
  .replace(/\.\d{3}Z$/, "")
  .replace("T", "-");
const newTag = `${imageName}:staging-${timestamp}`;
const latestTag = `${imageName}:staging-latest`;

function runCommand(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; fatal?: boolean; stream?: boolean } = {}
) {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    env: options.env,
    stdio: options.stream ? "inherit" : "pipe"
  });
  const success = result.status === 0;
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";

  if (!success && options.fatal !== false) {
    if (stderr) console.error(stderr);
    console.error(`\nCommand failed: ${command} ${args.join(" ")}`);
    process.exit(1);
  }

  return { success, stdout, stderr };
}

function docker(
  args: string[],
  options: { fatal?: boolean; stream?: boolean } = {}
) {
  return runCommand("docker", ["--context", context, ...args], options);
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function compose(workingDir: string, project: string) {
  return runCommand("ssh", [
    sshHost,
    `cd ${shellQuote(workingDir)} && docker compose --project-name ${shellQuote(project)} up --detach --force-recreate ${shellQuote(serviceName)}`
  ]);
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

console.log("🫒 Olive staging deploy");
console.log(`  Context: ${context}`);
console.log(`  SSH host: ${sshHost}`);
console.log(`  URL: ${stagingUrl}`);
console.log(`  Container: ${containerName}`);
console.log(`  New image: ${newTag}`);

const inspect = docker(["inspect", "--format", "{{json .}}", containerName], {
  fatal: false
});

let previous:
  | {
      image: string;
      imageId: string;
      status: string;
      composeWorkingDir: string;
      composeProject: string;
    }
  | undefined;

if (inspect.success && inspect.stdout) {
  try {
    const container = JSON.parse(inspect.stdout) as {
      Config?: {
        Image?: string;
        Labels?: Record<string, string>;
      };
      Image?: string;
      State?: { Status?: string };
    };
    if (!container.Config?.Image || !container.Image) {
      throw new Error("missing image details");
    }
    const composeWorkingDir =
      container.Config.Labels?.["com.docker.compose.project.working_dir"];
    const composeProject =
      container.Config.Labels?.["com.docker.compose.project"];
    if (!composeWorkingDir || !composeProject) {
      throw new Error("missing Compose project metadata");
    }
    previous = {
      image: container.Config.Image,
      imageId: container.Image,
      status: container.State?.Status ?? "unknown",
      composeWorkingDir,
      composeProject
    };
    console.log(
      `  Current image: ${previous.image} (${previous.imageId}, ${previous.status})`
    );
    console.log(`  Compose project: ${composeProject} (${composeWorkingDir})`);
  } catch {
    console.error(`\nCould not read current image details for ${containerName}.`);
    process.exit(1);
  }
}

if (!previous) {
  console.error(
    `\nCannot deploy without an existing Compose-managed ${containerName} container.`
  );
  process.exit(1);
}

// Build tags list: include staging tags plus whatever image name compose is currently configured with
const tagsToApply = ["-t", newTag, "-t", latestTag];
if (previous.image && previous.image !== newTag && previous.image !== latestTag) {
  tagsToApply.push("-t", previous.image);
}

console.log("\n🔨 Building image on staging Docker context...");
docker(
  [
    "build",
    "--platform",
    targetPlatform,
    "--build-arg",
    `APP_VERSION=${process.env.npm_package_version ?? "0.1.0"}`,
    "--build-arg",
    `BUILD_DATE=${buildDate}`,
    ...tagsToApply,
    "."
  ],
  { stream: true }
);

console.log(`\n🚀 Recreating ${containerName} through Compose on ${sshHost}...`);
compose(previous.composeWorkingDir, previous.composeProject);

const updated = docker(["inspect", "--format", "{{.Image}}", containerName], {
  fatal: false
});

if (
  !updated.success ||
  !updated.stdout ||
  (previous && updated.stdout === previous.imageId)
) {
  console.error("\n⚠️ Deploy did not replace the running image.");
  process.exit(1);
}

console.log(`  Image updated: ${updated.stdout}`);
console.log(`\n⏳ Waiting for health check (${stagingUrl}/api/health)...`);

let healthy = false;
for (let elapsed = 1; elapsed <= healthTimeout; elapsed += 1) {
  await sleep(1000);
  try {
    const response = await fetch(`${stagingUrl}/api/health`, {
      signal: AbortSignal.timeout(4000)
    });
    if (response.ok) {
      const body = (await response.json()) as { status?: string };
      if (body.status === "ok") {
        healthy = true;
        console.log(`  ✅ Healthy after ${elapsed}s (status: ${body.status}).`);
        break;
      }
    }
  } catch {
    // Fallback attempt via SSH curl if local network routing to stagingUrl is unavailable
    const sshCurl = runCommand(
      "ssh",
      [sshHost, `curl -s -f http://localhost:4470/api/health`],
      { fatal: false }
    );
    if (sshCurl.success && sshCurl.stdout.includes('"status":"ok"')) {
      healthy = true;
      console.log(`  ✅ Healthy via internal host after ${elapsed}s.`);
      break;
    }
  }
}

if (!healthy) {
  console.error("\n❌ Health check failed. Recent container logs:");
  docker(["logs", "--tail", "50", containerName], { fatal: false });
  process.exit(1);
}

const images = docker(["images", imageName, "--format", "{{.Tag}}"], {
  fatal: false
});
if (images.success) {
  const staleTags = images.stdout
    .split("\n")
    .filter((tag) => tag.startsWith("staging-") && tag !== "staging-latest")
    .slice(imageRetention);
  for (const tag of staleTags) {
    docker(["rmi", `${imageName}:${tag}`], { fatal: false });
  }
}

console.log(`\n✨ Staging deploy complete: ${newTag}`);
