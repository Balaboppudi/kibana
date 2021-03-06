/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { IClusterClient, IScopedClusterClient } from 'kibana/server';
// including KibanaRequest from 'kibana/server' causes an error
// when being used with instanceof
// eslint-disable-next-line @kbn/eslint/no-restricted-paths
import { KibanaRequest } from '../../.././../../src/core/server/http';
import { MlServerLicense } from '../lib/license';

import { SpacesPluginSetup } from '../../../spaces/server';
import { CloudSetup } from '../../../cloud/server';
import { licenseChecks } from './license_checks';
import { MlSystemProvider, getMlSystemProvider } from './providers/system';
import { JobServiceProvider, getJobServiceProvider } from './providers/job_service';
import { ModulesProvider, getModulesProvider } from './providers/modules';
import { ResultsServiceProvider, getResultsServiceProvider } from './providers/results_service';
import {
  AnomalyDetectorsProvider,
  getAnomalyDetectorsProvider,
} from './providers/anomaly_detectors';
import { ResolveMlCapabilities, MlCapabilitiesKey } from '../../common/types/capabilities';
import { hasMlCapabilitiesProvider, HasMlCapabilities } from '../lib/capabilities';
import { MLClusterClientUninitialized } from './errors';

export type SharedServices = JobServiceProvider &
  AnomalyDetectorsProvider &
  MlSystemProvider &
  ModulesProvider &
  ResultsServiceProvider;

interface Guards {
  isMinimumLicense(): Guards;
  isFullLicense(): Guards;
  hasMlCapabilities: (caps: MlCapabilitiesKey[]) => Guards;
  ok(callback: OkCallback): any;
}

export type GetGuards = (request: KibanaRequest) => Guards;

export interface SharedServicesChecks {
  getGuards(request: KibanaRequest): Guards;
}

interface OkParams {
  scopedClient: IScopedClusterClient;
}

type OkCallback = (okParams: OkParams) => any;

export function createSharedServices(
  mlLicense: MlServerLicense,
  spaces: SpacesPluginSetup | undefined,
  cloud: CloudSetup,
  resolveMlCapabilities: ResolveMlCapabilities,
  getClusterClient: () => IClusterClient | null
): SharedServices {
  const getRequestItems = getRequestItemsProvider(resolveMlCapabilities, getClusterClient);
  const { isFullLicense, isMinimumLicense } = licenseChecks(mlLicense);

  function getGuards(request: KibanaRequest): Guards {
    const { hasMlCapabilities, scopedClient } = getRequestItems(request);
    const asyncGuards: Array<Promise<void>> = [];

    const guards: Guards = {
      isMinimumLicense: () => {
        isMinimumLicense();
        return guards;
      },
      isFullLicense: () => {
        isFullLicense();
        return guards;
      },
      hasMlCapabilities: (caps: MlCapabilitiesKey[]) => {
        asyncGuards.push(hasMlCapabilities(caps));
        return guards;
      },
      async ok(callback: OkCallback) {
        await Promise.all(asyncGuards);
        return callback({ scopedClient });
      },
    };
    return guards;
  }

  return {
    ...getJobServiceProvider(getGuards),
    ...getAnomalyDetectorsProvider(getGuards),
    ...getModulesProvider(getGuards),
    ...getResultsServiceProvider(getGuards),
    ...getMlSystemProvider(getGuards, mlLicense, spaces, cloud, resolveMlCapabilities),
  };
}

function getRequestItemsProvider(
  resolveMlCapabilities: ResolveMlCapabilities,
  getClusterClient: () => IClusterClient | null
) {
  return (request: KibanaRequest) => {
    const getHasMlCapabilities = hasMlCapabilitiesProvider(resolveMlCapabilities);
    let hasMlCapabilities: HasMlCapabilities;
    let scopedClient: IScopedClusterClient;
    // While https://github.com/elastic/kibana/issues/64588 exists we
    // will not receive a real request object when being called from an alert.
    // instead a dummy request object will be supplied
    const clusterClient = getClusterClient();

    if (clusterClient === null) {
      throw new MLClusterClientUninitialized(`ML's cluster client has not been initialized`);
    }

    if (request instanceof KibanaRequest) {
      hasMlCapabilities = getHasMlCapabilities(request);
      scopedClient = clusterClient.asScoped(request);
    } else {
      hasMlCapabilities = () => Promise.resolve();
      const { asInternalUser } = clusterClient;
      scopedClient = {
        asInternalUser,
        asCurrentUser: asInternalUser,
      };
    }
    return { hasMlCapabilities, scopedClient };
  };
}
