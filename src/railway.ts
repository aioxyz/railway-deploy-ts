import { gql, GraphQLClient } from 'graphql-request'
import { createClient, SubscribePayload } from 'graphql-ws'
import WebSocket from 'ws'
import * as core from '@actions/core'
import Observable from 'zen-observable'
import { createRailway } from '@crisog/railway-sdk'

const RAILWAY_API_TOKEN = core.getInput('RAILWAY_API_TOKEN')
const PROJECT_ID = core.getInput('PROJECT_ID')
const DEST_ENV_NAME = core.getInput('DEST_ENV_NAME')
const BRANCH_NAME = core.getInput('branch_name')
const DEPLOYMENT_MAX_TIMEOUT = core.getInput('MAX_TIMEOUT')

const ENDPOINT = 'backboard.railway.app/graphql/v2'

const railway = createRailway({ token: RAILWAY_API_TOKEN })

export async function railwayGraphQLRequest(
  query: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  variables: Record<string, any>,
  caller?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const client = new GraphQLClient(`https://${ENDPOINT}`, {
    headers: {
      authorization: `Bearer ${RAILWAY_API_TOKEN}`
    }
  })
  try {
    return await client.request({ document: query, variables })
  } catch (error) {
    if (caller === 'CREATE_ENVIRONMENT') {
      if (error instanceof Error && error.message.includes('504')) {
        console.log(
          `Gateway Timeout (504): The Railway API timed out. Will poll for updates.`
        )
        // Wait for the created environment to finish initializing
        console.log(
          'Waiting 15 seconds for environment to initialize and become available'
        )
        await new Promise((resolve) => setTimeout(resolve, 15000)) // Wait for 15 seconds
        return pollForEnvironment()
      }
    } else {
      core.setFailed(`Action failed with error: ${error}`)
    }
  }
}

// WebSocket client — used only for deployment status subscriptions
const wsClient = createClient({
  url: `wss://${ENDPOINT}`,
  webSocketImpl: WebSocket,
  connectionParams: () => ({
    headers: { Authorization: `Bearer ${RAILWAY_API_TOKEN}` }
  }),
  on: {
    connected: () => console.log('Connected to Railway WebSocket API'),
    error: (error) => console.error('WebSocket connection error:', error),
    closed: () => console.log('WebSocket connection closed')
  }
})

const DEPLOYMENT_STATUS_SUBSCRIPTION = `subscription deployment($id: String!) {
  deployment(id: $id) {
    id
    status
  }
}`

function toObservable(operation: SubscribePayload) {
  const observable = new Observable((observer) =>
    wsClient.subscribe(operation, {
      next: (data) => observer.next(data),
      error: (err) => observer.error(err),
      complete: () => observer.complete()
    })
  )

  return observable
}

export async function subscribeToDeployment(deploymentId: string) {
  console.log(`Starting subscription for deployment ${deploymentId}...`)

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(
      () => {
        if (subscription) subscription.unsubscribe()
        reject(
          new Error(
            `Deployment timed out after ${DEPLOYMENT_MAX_TIMEOUT || 15} minutes`
          )
        )
      },
      (parseInt(DEPLOYMENT_MAX_TIMEOUT) || 15) * 60 * 1000
    )

    const observable = toObservable({
      query: DEPLOYMENT_STATUS_SUBSCRIPTION,
      variables: { id: deploymentId }
    })

    const subscription = observable.subscribe({
      next: (result) => {
        if (!result.data?.deployment) {
          console.log('Received unexpected subscription data format:', result)
          return
        }
        const { status, id } = result.data.deployment
        console.log(`Deployment ${id} status: ${status}`)
        if (status === 'SUCCESS') {
          clearTimeout(timeoutId)
          subscription.unsubscribe()
          resolve('SUCCESS')
        } else if (status === 'FAILED' || status === 'CRASHED') {
          clearTimeout(timeoutId)
          subscription.unsubscribe()
          reject(new Error(`Deployment failed with status: ${status}`))
        }
      },
      error: (err) => {
        console.error('Subscription error:', err)
        clearTimeout(timeoutId)
        reject(err)
      },
      complete: () => {
        console.log('Subscription completed')
        clearTimeout(timeoutId)
        resolve('COMPLETED')
      }
    })
  })
}

export async function serviceConnect(image: string, id: string) {
  const result = await railway.services.connect({
    variables: { id, input: { image } }
  })
  if (result.isErr()) {
    core.setFailed(`Service connection failed: ${result.error}`)
    return
  }
  console.log(`Service ${id} connected to ${image} successfully`)
}

export async function deleteEnvironment(id: string) {
  const result = await railway.environments.delete({ variables: { id } })
  if (result.isErr()) {
    core.setFailed(`Delete environment failed: ${result.error}`)
    return
  }
  console.log(`Environment ${DEST_ENV_NAME} deleted successfully`)
}

export async function getEnvironments() {
  const result = await railway.environments.list({
    variables: { projectId: PROJECT_ID, first: 100 }
  })
  if (result.isErr()) throw result.error
  return result.value.environments
}

// railway-sdk doesn't include serviceinstances
// and deploy triggers in its "get environment" query...
// https://github.com/crisog/railway-sdk/blob/main/src/graphql/queries/environment.graphql#L7
// otherwise, we'd just do this:

// export async function getEnvironment(id: string) {
//   const result = await railway.environments.get({ variables: { id } })
//   if (result.isErr()) throw result.error
//   // Wrap to match the shape callers expect from createEnvironment
//   return { environmentCreate: result.value.environment }
// }

export async function getEnvironment(id: string) {
  const query = gql`
    query environment($id: String!) {
      environment(id: $id) {
        id
        name
        createdAt
        deploymentTriggers {
          edges {
            node {
              id
              environmentId
              branch
              projectId
            }
          }
        }
        serviceInstances {
          edges {
            node {
              id
              domains {
                serviceDomains {
                  domain
                  id
                }
              }
              serviceId
            }
          }
        }
      }
    }
  `

  const variables = {
    id
  }

  const res = await railwayGraphQLRequest(query, variables)
  return { environmentCreate: res.environment }
}

function hasTriggersAndServices(environment) {
  return (
    environment.serviceInstances.edges.length > 0 &&
    environment.deploymentTriggers.edges.length > 0
  )
}

export async function pollForEnvironment(maxAttempts = 6, initialDelay = 2000) {
  let attemptCount = 0
  let delay = initialDelay

  const checkEnvironment = async () => {
    attemptCount++
    console.log(`Polling for environment (attempt ${attemptCount})...`)

    const envs = await getEnvironments()
    const target = envs.find((e) => e.name === DEST_ENV_NAME)

    if (target) {
      const env = await getEnvironment(target.id)
      console.log(`Environment "${DEST_ENV_NAME}" found:`)
      console.dir(env, { depth: null })

      if (!hasTriggersAndServices(env.environmentCreate)) {
        core.info(`Environment returned empty, retrying in ${delay / 1000}s...`)
        await new Promise((resolve) => setTimeout(resolve, delay))
        delay *= 2
        return checkEnvironment()
      }

      return env.environmentCreate
    }

    if (attemptCount >= maxAttempts) {
      throw new Error(
        `Reached maximum attempts (${maxAttempts}). Environment not found.`
      )
    }

    console.log(`Environment not found yet. Retrying in ${delay / 1000}s...`)
    await new Promise((resolve) => setTimeout(resolve, delay))
    delay *= 2
    return checkEnvironment()
  }

  return checkEnvironment()
}

export async function createEnvironment(sourceEnvironmentId: string) {
  console.log('Creating environment based on source:', sourceEnvironmentId)

  const result = await railway.environments.create({
    variables: {
      input: {
        name: DEST_ENV_NAME,
        projectId: PROJECT_ID,
        skipInitialDeploys: true,
        sourceEnvironmentId,
        ephemeral: true
      }
    }
  })

  if (result.isErr()) {
    const msg = result.error.message ?? ''
    if (msg.includes('504')) {
      console.log('Gateway Timeout (504): polling for environment...')
      console.log('Waiting 15 seconds for environment to initialize')
      await new Promise((resolve) => setTimeout(resolve, 15000))
      return pollForEnvironment()
    }
    core.setFailed(`Action failed: ${result.error}`)
    return
  }

  const createdEnvironment = result.value.environmentCreate

  const env = await getEnvironment(createdEnvironment.id)

  if (!hasTriggersAndServices(env.environmentCreate)) {
    core.info('Environment missing triggers/services, waiting for creation...')
    await new Promise((resolve) => setTimeout(resolve, 15000))
    return pollForEnvironment()
  }

  return env.environmentCreate
}

export async function updateEnvironment(
  environmentId: string,
  serviceId: string,
  variables: string
) {
  const parsedVariables = JSON.parse(variables)

  const result = await railway.variables.collectionUpsert({
    variables: {
      input: {
        environmentId,
        projectId: PROJECT_ID,
        serviceId,
        variables: parsedVariables
      }
    }
  })

  if (result.isErr()) {
    core.setFailed(`Variable upsert failed: ${result.error}`)
  }
}

export async function deploymentTriggerUpdate(deploymentTriggerId: string) {
  console.log('Updating deployment trigger to branch:', BRANCH_NAME)

  const result = await railway.deployments.triggers.update({
    variables: {
      id: deploymentTriggerId,
      input: { branch: BRANCH_NAME }
    }
  })

  if (result.isErr()) {
    core.setFailed(`Deployment trigger update failed: ${result.error}`)
  }
}

export async function serviceInstanceDeploy(
  environmentId: string,
  serviceId: string
) {
  console.log(`Deploying service ${serviceId} in environment ${environmentId}`)

  const result = await railway.services.instances.deployV2({
    variables: { environmentId, serviceId }
  })

  if (result.isErr()) {
    core.setFailed(`Service deploy failed: ${result.error}`)
    return
  }

  const id = result.value.serviceInstanceDeployV2

  return id
}

export async function updateAllDeploymentTriggers(
  deploymentTriggerIds: string[]
) {
  await Promise.all(
    deploymentTriggerIds.map((id) => deploymentTriggerUpdate(id))
  )
  console.log('All deployment triggers updated successfully.')
}

async function createVolume(
  environmentId: string,
  volume: { path: string; svc_name: string; svc_id: string }
) {
  console.log('Creating volume for service:', volume.svc_name)

  const result = await railway.volumes.create({
    variables: {
      input: {
        environmentId,
        mountPath: volume.path,
        serviceId: volume.svc_id,
        projectId: PROJECT_ID
      }
    }
  })

  if (result.isErr()) {
    console.error('Failed to create volume:', result.error)
  } else {
    console.log(`Volume created at ${volume.path} for ${volume.svc_name}`)
  }
}

export async function createVolumes(
  environmentId: string,
  volumes: { path: string; svc_name: string; svc_id: string }[]
) {
  await Promise.all(volumes.map((v) => createVolume(environmentId, v)))
  console.log('All volumes created successfully.')
}

export async function updateEnvironmentVariablesForServices(
  environmentId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  serviceInstances: any[],
  ENV_VARS: string
) {
  const serviceIds = serviceInstances.map((si) => si.serviceId)
  await Promise.all(
    serviceIds.map((serviceId) =>
      updateEnvironment(environmentId, serviceId, ENV_VARS)
    )
  )
  console.log('Environment variables updated for all services.')
}

export async function deployAllServices(
  environmentId: string,
  servicesToRedeploy: { id: string; name: string }[],
  enforceOrder = false
) {
  if (enforceOrder) {
    console.log(
      'Enforcing deployment order:',
      servicesToRedeploy.map((s) => s.name).join(', ')
    )
    for (const service of servicesToRedeploy) {
      const deploymentId = await serviceInstanceDeploy(
        environmentId,
        service.id
      )
      if (!deploymentId) {
        throw new Error(`No deployment ID returned for ${service.name}`)
      }

      console.log(`Waiting for deployment ${deploymentId} to complete...`)
      const status = await subscribeToDeployment(deploymentId)
      console.log(`Service ${service.name} completed with status: ${status}`)
    }
  } else {
    await Promise.all(
      servicesToRedeploy.map((s) => serviceInstanceDeploy(environmentId, s.id))
    )
    console.log('All services deployed successfully.')
  }
}

export async function getService(serviceId: string) {
  const result = await railway.services.get({ variables: { id: serviceId } })
  if (result.isErr()) throw result.error
  return result.value
}
