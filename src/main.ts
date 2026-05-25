/* eslint-disable @typescript-eslint/no-explicit-any */
import * as core from '@actions/core'
import {
  getEnvironments,
  createEnvironment,
  updateEnvironmentVariablesForServices,
  updateAllDeploymentTriggers,
  getService,
  deployAllServices,
  deleteEnvironment,
  serviceConnect,
  createVolumes
} from './railway.js'

const MODE = core.getInput('MODE')
const DEST_ENV_NAME = core.getInput('DEST_ENV_NAME')
const PROJECT_ID = core.getInput('PROJECT_ID')
const SRC_ENVIRONMENT_NAME = core.getInput('SRC_ENVIRONMENT_NAME')
const SRC_ENVIRONMENT_ID = core.getInput('SRC_ENVIRONMENT_ID')
const SRC_IMG = core.getInput('SRC_IMG')
const SVC_ID = core.getInput('SVC_ID')
const ENV_VARS = core.getInput('ENV_VARS')
const API_SERVICE_NAME = core.getInput('API_SERVICE_NAME')
const DEPLOYMENT_ORDER = core.getInput('DEPLOYMENT_ORDER')
const IGNORE_SERVICE_REDEPLOY = core.getInput('IGNORE_SERVICE_REDEPLOY')
const VOLUMES = core.getInput('VOLUMES')

async function runCreate(): Promise<void> {
  if (!SRC_ENVIRONMENT_NAME || !PROJECT_ID) {
    console.log(
      'SRC_ENVIRONMENT_NAME and PROJECT_ID are required when creating a new environment'
    )
    core.setFailed('Environment creation aborted')
  }
  try {
    const environments = await getEnvironments()

    const existing = environments.find((e: any) => e.name === DEST_ENV_NAME)
    if (existing) {
      throw new Error(
        'Environment already exists. Please delete the environment via API or Railway Dashboard and try again.'
      )
    }

    let srcEnvironmentId = SRC_ENVIRONMENT_ID
    if (!SRC_ENVIRONMENT_ID) {
      const src = environments.find((e: any) => e.name === SRC_ENVIRONMENT_NAME)
      if (!src)
        throw new Error(
          `Source environment "${SRC_ENVIRONMENT_NAME}" not found`
        )
      srcEnvironmentId = src.id
    }

    const createdEnvironment = await createEnvironment(srcEnvironmentId)

    console.log('Created Environment:')
    console.dir(createdEnvironment, { depth: null })

    const env = createdEnvironment.environmentCreate

    const { id: environmentId } = env

    // Get all the Deployment Triggers
    const deploymentTriggerIds: string[] = []
    for (const deploymentTrigger of env.deploymentTriggers.edges) {
      const { id: deploymentTriggerId } = deploymentTrigger.node
      deploymentTriggerIds.push(deploymentTriggerId)
    }

    const { serviceInstances } = env

    await updateEnvironmentVariablesForServices(
      environmentId,
      serviceInstances,
      ENV_VARS
    )

    await updateAllDeploymentTriggers(deploymentTriggerIds)

    const servicesToIgnore = JSON.parse(IGNORE_SERVICE_REDEPLOY)
    const deploymentOrder: string[] = JSON.parse(DEPLOYMENT_ORDER)

    const servicePromises: Promise<{
      id: string
      name: string
      domains: any
    }>[] = serviceInstances.edges.map(async (si: any) => {
      const { domains, serviceId } = si.node
      const { service } = await getService(serviceId)
      const { name } = service
      return { name, id: serviceId, domains }
    })

    const allServices = await Promise.all(servicePromises)

    let servicesToDeploy: { id: string; name: string; domains: any }[] =
      allServices.filter((s) => !servicesToIgnore.includes(s.name))

    const volumes = JSON.parse(VOLUMES) as { svc_name: string; path: string }[]
    const volumesToCreate = volumes.map((volume) => {
      const svc_id = servicesToDeploy.find(
        (s) => s.name === volume.svc_name
      )?.id
      if (!svc_id) {
        throw new Error(
          `Volume Creation: Service ${volume.svc_name} not found in the environment`
        )
      }
      return { ...volume, svc_id }
    })

    if (volumesToCreate.length > 0) {
      await createVolumes(environmentId, volumesToCreate)
    }

    const enforceOrder = deploymentOrder && deploymentOrder.length > 0

    if (enforceOrder) {
      servicesToDeploy = deploymentOrder.map((name) => {
        const service = servicesToDeploy.find(
          (s) => s.name.toLowerCase() === name.toLocaleLowerCase()
        )
        if (!service) {
          throw new Error(
            `Deployment Order: Service ${name} not found in the environment`
          )
        }
        return service
      })
    }

    for (const service of servicesToDeploy) {
      const { name, domains } = service
      if (
        (API_SERVICE_NAME && name === API_SERVICE_NAME) ||
        name === 'app' ||
        name === 'backend' ||
        name === 'web'
      ) {
        const domainData = domains?.serviceDomains?.[0]
        if (domainData) {
          const { domain } = domainData
          console.log('Domain:', domain)
          core.setOutput('service_domain', domain)
        } else {
          console.log('Domain data is undefined')
        }
      }
    }

    await deployAllServices(environmentId, servicesToDeploy, enforceOrder)
  } catch (error) {
    console.error('Error in runCreate:', error)
    core.setFailed('Environment creation failed')
  }
}

async function runDestroy(): Promise<void> {
  try {
    const environments = await getEnvironments()

    const target = environments.find((e: any) => e.name === DEST_ENV_NAME)
    if (!target) {
      throw new Error('Environment does not exist. Cannot delete.')
    }

    await deleteEnvironment(target.id)
  } catch (error) {
    console.error('Error in runDestroy:', error)
    core.setFailed('Environment destruction failed')
  }
}

async function runConnect(): Promise<void> {
  if (!SVC_ID || !SRC_IMG) {
    console.log('SVC_ID and SRC_IMG are required when MODE is CONNECT')
    core.setFailed('Service connection aborted')
  }
  try {
    await serviceConnect(SRC_IMG, SVC_ID)
  } catch (error) {
    console.error('Error in runConnect:', error)
    core.setFailed('Service Connect Failed')
  }
}

/**
 * The main function for the action.
 *
 * @returns Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  switch (MODE) {
    case 'CONNECT':
      runConnect()
      break
    case 'CREATE':
      runCreate()
      break
    case 'DESTROY':
      runDestroy()
      break
    default:
      core.setFailed(`Invalid MODE: ${MODE}. Only CREATE & DESTROY allowed`)
  }
}
