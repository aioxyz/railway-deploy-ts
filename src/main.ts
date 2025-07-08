/* eslint-disable @typescript-eslint/no-explicit-any */
import * as core from '@actions/core'
import {
  getEnvironments,
  createEnvironment,
  updateEnvironmentVariablesForServices,
  updateAllDeploymentTriggers,
  getService,
  deployAllServices,
  deleteEnvironment
} from './railway.js'

const MODE = core.getInput('MODE')
const DEST_ENV_NAME = core.getInput('DEST_ENV_NAME')
const PROJECT_ID = core.getInput('PROJECT_ID')
const SRC_ENVIRONMENT_NAME = core.getInput('SRC_ENVIRONMENT_NAME')
const SRC_ENVIRONMENT_ID = core.getInput('SRC_ENVIRONMENT_ID')
const ENV_VARS = core.getInput('ENV_VARS')
const API_SERVICE_NAME = core.getInput('API_SERVICE_NAME')
const DEPLOYMENT_ORDER = core.getInput('DEPLOYMENT_ORDER')
const IGNORE_SERVICE_REDEPLOY = core.getInput('IGNORE_SERVICE_REDEPLOY')

async function runCreate(): Promise<void> {
  if (!SRC_ENVIRONMENT_NAME || !PROJECT_ID) {
    console.log(
      'SRC_ENVIRONMENT_NAME and PROJECT_ID are required when creating a new environment'
    )
    core.setFailed('Environment creation aborted')
  }
  try {
    // Get Environments to check if the environment already exists
    const response = await getEnvironments()

    // Filter the response to only include the environment name we are looking to create
    const filteredEdges = response.environments.edges.filter(
      (edge: any) => edge.node.name === DEST_ENV_NAME
    )

    // If there is a match this means the environment already exists
    if (filteredEdges.length == 1) {
      throw new Error(
        'Environment already exists. Please delete the environment via API or Railway Dashboard and try again.'
      )
    }

    let srcEnvironmentId = SRC_ENVIRONMENT_ID

    // If no source ENV_ID provided get Source Environment ID to base new PR environment from (aka use the same environment variables)
    if (!SRC_ENVIRONMENT_ID) {
      srcEnvironmentId = response.environments.edges.filter(
        (edge) => edge.node.name === SRC_ENVIRONMENT_NAME
      )[0].node.id
    }

    // Create the new Environment based on the Source Environment
    const createdEnvironment = await createEnvironment(srcEnvironmentId)

    console.log('Created Environment:')
    console.dir(createdEnvironment, { depth: null })

    const { id: environmentId } = createdEnvironment.environmentCreate

    // Get all the Deployment Triggers
    const deploymentTriggerIds: string[] = []
    for (const deploymentTrigger of createdEnvironment.environmentCreate
      .deploymentTriggers.edges) {
      const { id: deploymentTriggerId } = deploymentTrigger.node
      deploymentTriggerIds.push(deploymentTriggerId)
    }

    // Get all the Service Instances
    const { serviceInstances } = createdEnvironment.environmentCreate

    // Update the Environment Variables on each Service Instance
    // TODO: ONLY ADD ENV_VARS to its corresponding service
    await updateEnvironmentVariablesForServices(
      environmentId,
      serviceInstances,
      ENV_VARS
    )

    // // Wait for the created environment to finish initializing
    // console.log(
    //   'Waiting 15 seconds for deployment to initialize and become available'
    // )
    // await new Promise((resolve) => setTimeout(resolve, 15000)) // Wait for 15 seconds

    // Set the Deployment Trigger Branch for Each Service
    await updateAllDeploymentTriggers(deploymentTriggerIds)

    const servicesToIgnore = JSON.parse(IGNORE_SERVICE_REDEPLOY)
    const deploymentOrder: string[] = JSON.parse(DEPLOYMENT_ORDER)
    let servicesToDeploy: { id: string; name: string; domains: any }[] =
      await createdEnvironment.environmentCreate.serviceInstances.edges
        .map(async (serviceInstance: any) => {
          const id = serviceInstance.node.serviceId
          const { domains } = serviceInstance.node
          const { service } = await getService(id)
          const { name } = service

          return {
            name,
            id,
            domains
          }
        })
        .filter(
          (s: { name: string; id: string }) =>
            !servicesToIgnore.includes(s.name)
        )

    const enforceOrder = deploymentOrder && deploymentOrder.length > 0

    // if deployment order is specified get the services in the correct order
    if (enforceOrder) {
      servicesToDeploy = deploymentOrder.map((name) => {
        const service = servicesToDeploy.find(
          (s) => s.name.toLowerCase() === name.toLocaleLowerCase()
        )
        if (!service) {
          throw new Error(`Service ${name} not found in the environment`)
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
        const domainData = domains.serviceDomains?.[0]
        if (domainData) {
          const { domain } = domainData
          console.log('Domain:', domain)
          core.setOutput('service_domain', domain)
        } else {
          console.log('Domain data is undefined')
          // Handle the case where serviceDomains is undefined
        }
      }
    }

    // Get the names for each deployed service
    // for (const service of servicesToDeploy) {
    //   const { domains } = serviceInstance.node
    //   const { service } = await getService(serviceInstance.node.serviceId)
    //   const { name } = service

    //   if (!servicesToIgnore.includes(name)) {
    //     servicesToDeploy.push(serviceInstance.node.serviceId)
    //   }

    //   if (deploymentOrder && deploymentOrder.length > 0) {
    //     if (deploymentOrder.includes(name)) {
    //     }
    //   }

    //   if (
    //     (API_SERVICE_NAME && name === API_SERVICE_NAME) ||
    //     name === 'app' ||
    //     name === 'backend' ||
    //     name === 'web'
    //   ) {
    //     const domainData = domains.serviceDomains?.[0]
    //     if (domainData) {
    //       const { domain } = domainData
    //       console.log('Domain:', domain)
    //       core.setOutput('service_domain', domain)
    //     } else {
    //       console.log('Domain data is undefined')
    //       // Handle the case where serviceDomains is undefined
    //     }
    //   }
    // }

    // Redeploy the Services
    await deployAllServices(environmentId, servicesToDeploy, enforceOrder)
  } catch (error) {
    console.error('Error in runCreate:', error)
    // Handle the error, e.g., fail the action
    core.setFailed('Environment creation failed')
  }
}

async function runDestroy(): Promise<void> {
  try {
    const response = await getEnvironments()

    // Filter the response to only include the environment name we are looking to create
    const filteredEdges = response.environments.edges.filter(
      (edge: any) => edge.node.name === DEST_ENV_NAME
    )

    // If there is a match this means the environment already exists
    if (filteredEdges.length == 1) {
      const environmentId = filteredEdges[0].node.id
      await deleteEnvironment(environmentId)
    } else {
      throw new Error('Environment does not exists. Cannot delete.')
    }
  } catch (error) {
    console.error('Error in runDestroy:', error)
    // Handle the error, e.g., fail the action
    core.setFailed('Environment destruction failed')
  }
}

/**
 * The main function for the action.
 *
 * @returns Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  switch (MODE) {
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
