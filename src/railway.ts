/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { gql, GraphQLClient } from 'graphql-request'
import * as core from '@actions/core'

// Railway Required Inputs
const RAILWAY_API_TOKEN = core.getInput('RAILWAY_API_TOKEN')
const PROJECT_ID = core.getInput('PROJECT_ID')
const DEST_ENV_NAME = core.getInput('DEST_ENV_NAME')
const ENDPOINT = 'https://backboard.railway.app/graphql/v2'

// Github Required Inputs
const BRANCH_NAME = core.getInput('branch_name') || 'feat-railway-7'

// Optional Inputs
const DEPLOYMENT_MAX_TIMEOUT = core.getInput('MAX_TIMEOUT')

function hasTriggersAndServices(environment: any): boolean {
  const createdEnvironment = environment.environmentCreate
  if (!createdEnvironment) {
    return false
  }
  return (
    createdEnvironment.serviceInstances?.edges.length > 0 &&
    createdEnvironment.deploymentTriggers?.edges.length > 0
  )
}

export async function railwayGraphQLRequest(
  query: string,
  variables: Record<string, any>,
  caller?: string
): Promise<any> {
  const client = new GraphQLClient(ENDPOINT, {
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

export async function deleteEnvironment(id: string) {
  const query = gql`
    mutation environmentDelete($id: String!) {
      environmentDelete(id: $id)
    }
  `
  const variables = {
    id
  }
  try {
    await railwayGraphQLRequest(query, variables)
    console.log(`Environment ${DEST_ENV_NAME} deleted successfully`)
  } catch (error) {
    core.setFailed(`Delete Environment failed with error: ${error}`)
  }
}

export async function getProject() {
  const query = gql`
    query project($id: String!) {
      project(id: $id) {
        name
        services {
          edges {
            node {
              id
              name
            }
          }
        }
        environments {
          edges {
            node {
              id
              name
              serviceInstances {
                edges {
                  node {
                    serviceId
                    startCommand
                    domains {
                      serviceDomains {
                        domain
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `

  const variables = {
    id: PROJECT_ID
  }

  return await railwayGraphQLRequest(query, variables)
}

export async function getEnvironments() {
  const query = gql`
    query environments($projectId: String!) {
      environments(projectId: $projectId) {
        edges {
          node {
            id
            name
            deployments {
              edges {
                node {
                  id
                  status
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
                    }
                  }
                  serviceId
                  startCommand
                }
              }
            }
          }
        }
      }
    }
  `

  const variables = {
    projectId: PROJECT_ID
  }

  return await railwayGraphQLRequest(query, variables)
}

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

export async function pollForEnvironment(maxAttempts = 6, initialDelay = 2000) {
  let attemptCount = 0
  let delay = initialDelay

  const checkEnvironment = async () => {
    attemptCount++
    console.log(`Polling for environment (attempt ${attemptCount})...`)

    const result = await getEnvironments()
    if (!result || !result.environments || !result.environments.edges) {
      console.log('No environments data returned.')
      return null
    }

    const targetEnvironment = result.environments.edges.find(
      (edge: any) => edge.node.name === DEST_ENV_NAME
    )

    if (targetEnvironment) {
      const env = await getEnvironment(targetEnvironment.node.id)
      console.log(`Environment "${DEST_ENV_NAME}" found:`)
      console.dir(env, { depth: null })
      if (!env || !hasTriggersAndServices(env)) {
        core.info(
          `Environment returned empty, Retrying in ${delay / 1000} seconds...`
        )
        await new Promise((resolve) => setTimeout(resolve, delay))
        delay *= 2 // Exponential backoff
        return checkEnvironment()
      }
      return env
    }

    if (attemptCount >= maxAttempts) {
      console.log(
        `Reached maximum attempts (${maxAttempts}). Environment not found.`
      )
      return null
    }

    console.log(
      `Environment not found yet. Retrying in ${delay / 1000} seconds...`
    )
    await new Promise((resolve) => setTimeout(resolve, delay))
    delay *= 2 // Exponential backoff
    return checkEnvironment()
  }

  return checkEnvironment()
}

export async function createEnvironment(sourceEnvironmentId: string) {
  console.log(
    'Creating Environment... based on source environment ID:',
    sourceEnvironmentId
  )
  try {
    const query = gql`
      mutation environmentCreate($input: EnvironmentCreateInput!) {
        environmentCreate(input: $input) {
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
      input: {
        name: DEST_ENV_NAME,
        projectId: PROJECT_ID,
        skipInitialDeploys: true,
        sourceEnvironmentId: sourceEnvironmentId
      }
    }
    const createdEnvironment = await railwayGraphQLRequest(
      query,
      variables,
      'CREATE_ENVIRONMENT'
    )
    if (!createdEnvironment || !hasTriggersAndServices(createdEnvironment)) {
      core.info('Environment returned empty, polling...')
      // Wait for the created environment to finish initializing
      console.log(
        'Waiting 15 seconds for environment to initialize and become available'
      )
      await new Promise((resolve) => setTimeout(resolve, 15000)) // Wait for 15 seconds
      return await pollForEnvironment()
    }
    return createdEnvironment
  } catch (error) {
    core.setFailed(`Action failed with error: ${error}`)
  }
}

export async function updateEnvironment(
  environmentId: string,
  serviceId: string,
  variables: string
) {
  const parsedVariables = JSON.parse(variables)

  try {
    const query = gql`
      mutation variableCollectionUpsert(
        $input: VariableCollectionUpsertInput!
      ) {
        variableCollectionUpsert(input: $input)
      }
    `

    const variables = {
      input: {
        environmentId: environmentId,
        projectId: PROJECT_ID,
        serviceId: serviceId,
        variables: parsedVariables
      }
    }

    return await railwayGraphQLRequest(query, variables)
  } catch (error) {
    core.setFailed(`Action failed with error: ${error}`)
  }
}

export async function deploymentTriggerUpdate(deploymentTriggerId: string) {
  console.log('Updating Deploying Trigger to new Branch Name')
  try {
    const query = gql`
      mutation deploymentTriggerUpdate(
        $id: String!
        $input: DeploymentTriggerUpdateInput!
      ) {
        deploymentTriggerUpdate(id: $id, input: $input) {
          id
        }
      }
    `

    const variables = {
      id: deploymentTriggerId,
      input: {
        branch: BRANCH_NAME
      }
    }

    return await railwayGraphQLRequest(query, variables)
  } catch (error) {
    core.setFailed(`Action failed with error: ${error}`)
  }
}

export async function serviceInstanceDeploy(
  environmentId: string,
  serviceId: string
) {
  console.log('Deploying Service...')
  console.log('Environment ID:', environmentId)
  console.log('Service ID:', serviceId)
  try {
    const query = gql`
      mutation serviceInstanceDeploy(
        $environmentId: String!
        $serviceId: String!
      ) {
        serviceInstanceDeploy(
          environmentId: $environmentId
          serviceId: $serviceId
        )
      }
    `

    const variables = {
      environmentId: environmentId,
      serviceId: serviceId
    }

    return await railwayGraphQLRequest(query, variables)
  } catch (error) {
    core.setFailed(`Action failed with error: ${error}`)
  }
}

export async function updateAllDeploymentTriggers(
  deploymentTriggerIds: string[]
) {
  try {
    // Create an array of promises
    const updatePromises = deploymentTriggerIds.map((deploymentTriggerId) =>
      deploymentTriggerUpdate(deploymentTriggerId)
    )

    // Await all promises
    await Promise.all(updatePromises)
    console.log('All deployment triggers updated successfully.')
  } catch (error) {
    console.error('An error occurred during the update:', error)
  }
}

export async function updateEnvironmentVariablesForServices(
  environmentId: string,
  serviceInstances: Record<string, any>,
  ENV_VARS: string
) {
  const serviceIds: string[] = []

  // Extract service IDs
  for (const serviceInstance of serviceInstances.edges) {
    const { serviceId } = serviceInstance.node
    serviceIds.push(serviceId)
  }

  try {
    // Create an array of promises for updating environment variables
    const updatePromises = serviceIds.map((serviceId) =>
      updateEnvironment(environmentId, serviceId, ENV_VARS)
    )

    // Await all promises to complete
    await Promise.all(updatePromises)
    console.log('Environment variables updated for all services.')
  } catch (error) {
    console.error('An error occurred during the update:', error)
  }
}

export async function deployAllServices(
  environmentId: string,
  servicesToRedeploy: string[]
) {
  try {
    // Create an array of promises for redeployments
    const redeployPromises = servicesToRedeploy.map((serviceId) =>
      serviceInstanceDeploy(environmentId, serviceId)
    )

    // Await all promises to complete
    await Promise.all(redeployPromises)
    console.log('All services deployed successfully.')
  } catch (error) {
    console.error('An error occurred during redeployment:', error)
  }
}

export async function getService(serviceId: string) {
  const query = `query environments($id: String!) {
            service(id: $id) {
                name
                }
        }`

  const variables = {
    id: serviceId
  }

  return await railwayGraphQLRequest(query, variables)
}
