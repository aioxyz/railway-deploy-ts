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
        return pollForEnvironment()
      }
    } else {
      core.setFailed(`Action failed with error: ${error}`)
    }
  }
}

export async function getProject() {
  const query = `query project($id: String!) {
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
        }`

  const variables = {
    id: PROJECT_ID
  }

  return await railwayGraphQLRequest(query, variables)
}

export async function getEnvironments() {
  const query = `query environments($projectId: String!) {
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
        }`

  const variables = {
    projectId: PROJECT_ID
  }

  return await railwayGraphQLRequest(query, variables)
}

async function pollForEnvironment(maxAttempts = 6, initialDelay = 2000) {
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
      console.log(`Environment "${DEST_ENV_NAME}" found!`)
      return { environmentCreate: targetEnvironment.node }
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
        sourceEnvironmentId: sourceEnvironmentId
      }
    }
    return await railwayGraphQLRequest(query, variables, 'CREATE_ENVIRONMENT')
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

export async function serviceInstanceRedeploy(
  environmentId: string,
  serviceId: string
) {
  console.log('Redeploying Service...')
  console.log('Environment ID:', environmentId)
  console.log('Service ID:', serviceId)
  try {
    const query = gql`
      mutation serviceInstanceRedeploy(
        $environmentId: String!
        $serviceId: String!
      ) {
        serviceInstanceRedeploy(
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

export async function redeployAllServices(
  environmentId: string,
  servicesToRedeploy: string[]
) {
  try {
    // Create an array of promises for redeployments
    const redeployPromises = servicesToRedeploy.map((serviceId) =>
      serviceInstanceRedeploy(environmentId, serviceId)
    )

    // Await all promises to complete
    await Promise.all(redeployPromises)
    console.log('All services redeployed successfully.')
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
