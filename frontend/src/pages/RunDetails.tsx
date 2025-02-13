/*
 * Copyright 2018-2019 The Kubeflow Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import CircularProgress from '@material-ui/core/CircularProgress';
import InfoIcon from '@material-ui/icons/InfoOutlined';
import { flatten } from 'lodash';
import * as React from 'react';
import { Link, Redirect } from 'react-router-dom';
import { ExternalLink } from 'src/atoms/ExternalLink';
import InputOutputTab from 'src/components/tabs/InputOutputTab';
import { MetricsTab } from 'src/components/tabs/MetricsTab';
import { GkeMetadata, GkeMetadataContext } from 'src/lib/GkeMetadata';
import { useNamespaceChangeEvent } from 'src/lib/KubeflowClient';
import { ExecutionHelpers, getExecutionsFromContext, getRunContext } from 'src/mlmd/MlmdUtils';
import { isV2Pipeline } from 'src/lib/v2/WorkflowUtils';
import { Context, Execution } from 'src/third_party/mlmd';
import { classes, stylesheet } from 'typestyle';
import {
  NodePhase as ArgoNodePhase,
  NodeStatus,
  Workflow,
} from '../../third_party/argo-ui/argo_template';
import { ApiExperiment } from '../apis/experiment';
import { ApiRun, ApiRunStorageState } from '../apis/run';
import { ApiVisualization, ApiVisualizationType } from '../apis/visualization';
import Hr from '../atoms/Hr';
import MD2Tabs from '../atoms/MD2Tabs';
import Separator from '../atoms/Separator';
import Banner, { Mode } from '../components/Banner';
import CompareTable from '../components/CompareTable';
import DetailsTable from '../components/DetailsTable';
import Graph from '../components/Graph';
import LogViewer from '../components/LogViewer';
import MinioArtifactPreview from '../components/MinioArtifactPreview';
import PlotCard from '../components/PlotCard';
import { PodEvents, PodInfo } from '../components/PodYaml';
import ReduceGraphSwitch from '../components/ReduceGraphSwitch';
import { RoutePage, RoutePageFactory, RouteParams } from '../components/Router';
import SidePanel from '../components/SidePanel';
import { ToolbarProps } from '../components/Toolbar';
import { HTMLViewerConfig } from '../components/viewers/HTMLViewer';
import { PlotType, ViewerConfig } from '../components/viewers/Viewer';
import { componentMap } from '../components/viewers/ViewerContainer';
import VisualizationCreator, {
  VisualizationCreatorConfig,
} from '../components/viewers/VisualizationCreator';
import { color, commonCss, fonts, fontsize, padding } from '../Css';
import { Apis } from '../lib/Apis';
import Buttons, { ButtonKeys } from '../lib/Buttons';
import CompareUtils from '../lib/CompareUtils';
import { OutputArtifactLoader } from '../lib/OutputArtifactLoader';
import RunUtils from '../lib/RunUtils';
import { compareGraphEdges, KeyValue, transitiveReduction } from '../lib/StaticGraphParser';
import { hasFinished, NodePhase } from '../lib/StatusUtils';
import {
  decodeCompressedNodes,
  errorToMessage,
  formatDateString,
  getRunDurationFromNode,
  getRunDurationFromWorkflow,
  logger,
  serviceErrorToString,
} from '../lib/Utils';
import WorkflowParser from '../lib/WorkflowParser';
import { ExecutionDetailsContent } from './ExecutionDetails';
import { Page, PageProps } from './Page';
import { statusToIcon } from './Status';

export enum SidePanelTab {
  INPUT_OUTPUT,
  VISUALIZATIONS,
  TASK_DETAILS,
  VOLUMES,
  LOGS,
  POD,
  EVENTS,
  ML_METADATA,
  MANIFEST,
}

interface SelectedNodeDetails {
  id: string;
  logs?: string;
  phase?: string;
  phaseMessage?: string;
}

// exported only for testing
export interface RunDetailsInternalProps {
  runId?: string;
  gkeMetadata: GkeMetadata;
}

export type RunDetailsProps = PageProps & Exclude<RunDetailsInternalProps, 'gkeMetadata'>;

interface AnnotatedConfig {
  config: ViewerConfig;
  stepName: string;
}

interface GeneratedVisualization {
  config: HTMLViewerConfig;
  nodeId: string;
}

interface RunDetailsState {
  allArtifactConfigs: AnnotatedConfig[];
  allowCustomVisualizations: boolean;
  experiment?: ApiExperiment;
  generatedVisualizations: GeneratedVisualization[];
  isGeneratingVisualization: boolean;
  logsBannerAdditionalInfo: string;
  logsBannerMessage: string;
  logsBannerMode: Mode;
  graph?: dagre.graphlib.Graph;
  reducedGraph?: dagre.graphlib.Graph;
  runFinished: boolean;
  runMetadata?: ApiRun;
  selectedTab: number;
  selectedNodeDetails: SelectedNodeDetails | null;
  sidepanelBannerMode: Mode;
  sidepanelBusy: boolean;
  sidepanelSelectedTab: SidePanelTab;
  workflow?: Workflow;
  mlmdRunContext?: Context;
  mlmdExecutions?: Execution[];
  showReducedGraph?: boolean;
  namespace?: string;
}

export const css = stylesheet({
  footer: {
    background: color.graphBg,
    display: 'flex',
    padding: '0 0 20px 20px',
  },
  graphPane: {
    backgroundColor: color.graphBg,
    overflow: 'hidden',
    position: 'relative',
  },
  infoSpan: {
    color: color.lowContrast,
    fontFamily: fonts.secondary,
    fontSize: fontsize.small,
    letterSpacing: '0.21px',
    lineHeight: '24px',
    paddingLeft: 6,
  },
  link: {
    color: '#77abda',
  },
  outputTitle: {
    color: color.strong,
    fontSize: fontsize.title,
    fontWeight: 'bold',
    paddingLeft: 20,
  },
});

class RunDetails extends Page<RunDetailsInternalProps, RunDetailsState> {
  public state: RunDetailsState = {
    allArtifactConfigs: [],
    allowCustomVisualizations: false,
    generatedVisualizations: [],
    isGeneratingVisualization: false,
    logsBannerAdditionalInfo: '',
    logsBannerMessage: '',
    logsBannerMode: 'error',
    runFinished: false,
    selectedNodeDetails: null,
    selectedTab: 0,
    sidepanelBannerMode: 'warning',
    sidepanelBusy: false,
    sidepanelSelectedTab: SidePanelTab.INPUT_OUTPUT,
    mlmdRunContext: undefined,
    mlmdExecutions: undefined,
    showReducedGraph: false,
  };

  private readonly AUTO_REFRESH_INTERVAL = 5000;

  private _interval?: NodeJS.Timeout;

  public getInitialToolbarState(): ToolbarProps {
    const buttons = new Buttons(this.props, this.refresh.bind(this));
    const runIdFromParams = this.props.match.params[RouteParams.runId];
    return {
      actions: buttons
        // BUG(talebz): AIP-6692 WFSDK: Disable Retry button
        // .retryRun(
        //   () =>
        //     this.state.runMetadata
        //       ? [this.state.runMetadata!.id!]
        //       : runIdFromParams
        //       ? [runIdFromParams]
        //       : [],
        //   true,
        //   () => this.retry(),
        // )
        .cloneRun(
          () =>
            this.state.runMetadata
              ? [this.state.runMetadata!.id!]
              : runIdFromParams
              ? [runIdFromParams]
              : [],
          true,
        )
        .terminateRun(
          () =>
            this.state.runMetadata
              ? [this.state.runMetadata!.id!]
              : runIdFromParams
              ? [runIdFromParams]
              : [],
          true,
          () => this.refresh(),
        )
        .getToolbarActionMap(),
      breadcrumbs: [{ displayName: 'Experiments', href: RoutePage.EXPERIMENTS }],
      pageTitle: this.props.runId!,
    };
  }

  public render(): JSX.Element {
    const {
      allArtifactConfigs,
      allowCustomVisualizations,
      isGeneratingVisualization,
      runFinished,
      runMetadata,
      selectedTab,
      sidepanelBannerMode,
      selectedNodeDetails,
      sidepanelSelectedTab,
      workflow,
      mlmdExecutions,
      showReducedGraph,
    } = this.state;
    const { projectId, clusterName } = this.props.gkeMetadata;
    const selectedNodeId = selectedNodeDetails?.id || '';
    const namespace = workflow?.metadata?.namespace;
    let stackdriverK8sLogsUrl = '';
    if (projectId && clusterName && selectedNodeDetails && selectedNodeDetails.id) {
      stackdriverK8sLogsUrl = `https://console.cloud.google.com/logs/viewer?project=${projectId}&interval=NO_LIMIT&advancedFilter=resource.type%3D"k8s_container"%0Aresource.labels.cluster_name:"${clusterName}"%0Aresource.labels.pod_name:"${selectedNodeDetails.id}"`;
    }

    const workflowParameters = WorkflowParser.getParameters(workflow);
    const { inputParams, outputParams } = WorkflowParser.getNodeInputOutputParams(
      workflow,
      selectedNodeId,
    );
    const { inputArtifacts, outputArtifacts } = WorkflowParser.getNodeInputOutputArtifacts(
      workflow,
      selectedNodeId,
    );
    const selectedExecution = mlmdExecutions?.find(
      execution => ExecutionHelpers.getKfpPod(execution) === selectedNodeId,
    );
    const hasMetrics = runMetadata && runMetadata.metrics && runMetadata.metrics.length > 0;
    const visualizationCreatorConfig: VisualizationCreatorConfig = {
      allowCustomVisualizations,
      isBusy: isGeneratingVisualization,
      onGenerate: (visualizationArguments: string, source: string, type: ApiVisualizationType) => {
        this._onGenerate(visualizationArguments, source, type, namespace || '');
      },
      type: PlotType.VISUALIZATION_CREATOR,
      collapsedInitially: true,
    };

    const graphToShow =
      this.state.showReducedGraph && this.state.reducedGraph
        ? this.state.reducedGraph
        : this.state.graph;
    return (
      <div className={classes(commonCss.page, padding(20, 't'))}>
        {!!workflow && (
          <div className={commonCss.page}>
            <MD2Tabs
              selectedTab={selectedTab}
              tabs={['Graph', 'Run output', 'Config']}
              onSwitch={(tab: number) => this.setStateSafe({ selectedTab: tab })}
            />
            <div className={commonCss.page}>
              {/* Graph tab */}
              {selectedTab === 0 && (
                <div className={classes(commonCss.page, css.graphPane)}>
                  {graphToShow && (
                    <div className={commonCss.page}>
                      <Graph
                        graph={graphToShow}
                        selectedNodeId={selectedNodeId}
                        onClick={id => this._selectNode(id)}
                        onError={(message, additionalInfo) =>
                          this.props.updateBanner({ message, additionalInfo, mode: 'error' })
                        }
                      />

                      <ReduceGraphSwitch
                        disabled={!this.state.reducedGraph}
                        checked={showReducedGraph}
                        onChange={_ => {
                          this.setState({ showReducedGraph: !this.state.showReducedGraph });
                        }}
                      />

                      <SidePanel
                        isBusy={this.state.sidepanelBusy}
                        isOpen={!!selectedNodeDetails}
                        onClose={() => this.setStateSafe({ selectedNodeDetails: null })}
                        title={selectedNodeId}
                      >
                        {!!selectedNodeDetails && (
                          <React.Fragment>
                            {!!selectedNodeDetails.phaseMessage && (
                              <Banner
                                mode={sidepanelBannerMode}
                                message={selectedNodeDetails.phaseMessage}
                              />
                            )}
                            <div className={commonCss.page}>
                              <MD2Tabs
                                tabs={this.getTabNames(workflow, selectedNodeId)}
                                selectedTab={sidepanelSelectedTab}
                                onSwitch={this._loadSidePaneTab.bind(this)}
                              />

                              <div
                                data-testid='run-details-node-details'
                                className={commonCss.page}
                              >
                                {sidepanelSelectedTab === SidePanelTab.VISUALIZATIONS &&
                                  this.state.selectedNodeDetails &&
                                  this.state.workflow &&
                                  !isV2Pipeline(workflow) && (
                                    <VisualizationsTabContent
                                      execution={selectedExecution}
                                      nodeId={selectedNodeId}
                                      nodeStatus={
                                        this.state.workflow && this.state.workflow.status
                                          ? this.state.workflow.status.nodes[
                                              this.state.selectedNodeDetails.id
                                            ]
                                          : undefined
                                      }
                                      namespace={this.state.workflow?.metadata?.namespace}
                                      visualizationCreatorConfig={visualizationCreatorConfig}
                                      generatedVisualizations={this.state.generatedVisualizations.filter(
                                        visualization =>
                                          visualization.nodeId === selectedNodeDetails.id,
                                      )}
                                      onError={this.handleError}
                                    />
                                  )}
                                {sidepanelSelectedTab === SidePanelTab.VISUALIZATIONS &&
                                  this.state.selectedNodeDetails &&
                                  this.state.workflow &&
                                  isV2Pipeline(workflow) &&
                                  selectedExecution && (
                                    <MetricsTab
                                      execution={selectedExecution}
                                      namespace={this.state.workflow?.metadata?.namespace}
                                    />
                                  )}

                                {sidepanelSelectedTab === SidePanelTab.INPUT_OUTPUT &&
                                  !isV2Pipeline(workflow) && (
                                    <div className={padding(20)}>
                                      <DetailsTable
                                        key={`input-parameters-${selectedNodeId}`}
                                        title='Input parameters'
                                        fields={inputParams}
                                      />

                                      <DetailsTable
                                        key={`input-artifacts-${selectedNodeId}`}
                                        title='Input artifacts'
                                        fields={inputArtifacts}
                                        valueComponent={MinioArtifactPreview}
                                        valueComponentProps={{
                                          namespace: this.state.workflow?.metadata?.namespace,
                                        }}
                                      />

                                      <DetailsTable
                                        key={`output-parameters-${selectedNodeId}`}
                                        title='Output parameters'
                                        fields={outputParams}
                                      />

                                      <DetailsTable
                                        key={`output-artifacts-${selectedNodeId}`}
                                        title='Output artifacts'
                                        fields={outputArtifacts}
                                        valueComponent={MinioArtifactPreview}
                                        valueComponentProps={{
                                          namespace: this.state.workflow?.metadata?.namespace,
                                        }}
                                      />
                                    </div>
                                  )}
                                {sidepanelSelectedTab === SidePanelTab.INPUT_OUTPUT &&
                                  isV2Pipeline(workflow) &&
                                  selectedExecution && (
                                    <InputOutputTab
                                      execution={selectedExecution}
                                      namespace={namespace}
                                    />
                                  )}

                                {sidepanelSelectedTab === SidePanelTab.TASK_DETAILS && (
                                  <div className={padding(20)}>
                                    <DetailsTable
                                      title='Task Details'
                                      fields={this._getTaskDetailsFields(workflow, selectedNodeId)}
                                    />
                                  </div>
                                )}

                                {sidepanelSelectedTab === SidePanelTab.ML_METADATA &&
                                  !isV2Pipeline(workflow) && (
                                    <div className={padding(20)}>
                                      {selectedExecution && (
                                        <>
                                          <div>
                                            This step corresponds to execution{' '}
                                            <Link
                                              className={commonCss.link}
                                              to={RoutePageFactory.executionDetails(
                                                selectedExecution.getId(),
                                              )}
                                            >
                                              "{ExecutionHelpers.getName(selectedExecution)}".
                                            </Link>
                                          </div>
                                          <ExecutionDetailsContent
                                            key={selectedExecution.getId()}
                                            id={selectedExecution.getId()}
                                            onError={
                                              ((msg: string, ...args: any[]) => {
                                                // TODO: show a proper error banner and retry button
                                                console.warn(msg);
                                              }) as any
                                            }
                                            // No title here
                                            onTitleUpdate={() => null}
                                          />
                                        </>
                                      )}
                                      {!selectedExecution && (
                                        <div>Corresponding ML Metadata not found.</div>
                                      )}
                                    </div>
                                  )}

                                {sidepanelSelectedTab === SidePanelTab.VOLUMES && (
                                  <div className={padding(20)}>
                                    <DetailsTable
                                      title='Volume Mounts'
                                      fields={WorkflowParser.getNodeVolumeMounts(
                                        workflow,
                                        selectedNodeId,
                                      )}
                                    />
                                  </div>
                                )}

                                {sidepanelSelectedTab === SidePanelTab.MANIFEST && (
                                  <div className={padding(20)}>
                                    <DetailsTable
                                      title='Resource Manifest'
                                      fields={WorkflowParser.getNodeManifest(
                                        workflow,
                                        selectedNodeId,
                                      )}
                                    />
                                  </div>
                                )}

                                {sidepanelSelectedTab === SidePanelTab.POD &&
                                  selectedNodeDetails.phase !== NodePhase.SKIPPED && (
                                    <div className={commonCss.page}>
                                      {selectedNodeId && namespace && (
                                        <PodInfo name={selectedNodeId} namespace={namespace} />
                                      )}
                                    </div>
                                  )}

                                {sidepanelSelectedTab === SidePanelTab.EVENTS &&
                                  selectedNodeDetails.phase !== NodePhase.SKIPPED && (
                                    <div className={commonCss.page}>
                                      {selectedNodeId && namespace && (
                                        <PodEvents name={selectedNodeId} namespace={namespace} />
                                      )}
                                    </div>
                                  )}

                                {sidepanelSelectedTab === SidePanelTab.LOGS &&
                                  selectedNodeDetails.phase !== NodePhase.SKIPPED && (
                                    <div className={commonCss.page}>
                                      {this.state.logsBannerMessage && (
                                        <React.Fragment>
                                          <Banner
                                            message={this.state.logsBannerMessage}
                                            mode={this.state.logsBannerMode}
                                            additionalInfo={this.state.logsBannerAdditionalInfo}
                                            showTroubleshootingGuideLink={false}
                                            refresh={this._loadSelectedNodeLogs.bind(this)}
                                          />
                                        </React.Fragment>
                                      )}
                                      {stackdriverK8sLogsUrl && (
                                        <div className={padding(12)}>
                                          Logs can also be viewed in{' '}
                                          <a
                                            href={stackdriverK8sLogsUrl}
                                            target='_blank'
                                            rel='noopener noreferrer'
                                            className={classes(css.link, commonCss.unstyled)}
                                          >
                                            Stackdriver Kubernetes Monitoring
                                          </a>
                                          .
                                        </div>
                                      )}
                                      {!this.state.logsBannerMessage &&
                                        this.state.selectedNodeDetails && (
                                          // Overflow hidden here, because scroll is handled inside
                                          // LogViewer.
                                          <div className={commonCss.pageOverflowHidden}>
                                            <LogViewer
                                              logLines={(
                                                this.state.selectedNodeDetails.logs || ''
                                              ).split('\n')}
                                            />
                                          </div>
                                        )}
                                    </div>
                                  )}
                              </div>
                            </div>
                          </React.Fragment>
                        )}
                      </SidePanel>

                      <div className={css.footer}>
                        <div className={commonCss.flex}>
                          <InfoIcon className={commonCss.infoIcon} />
                          <span className={css.infoSpan}>
                            Runtime execution graph. Only steps that are currently running or have
                            already completed are shown.
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                  {!graphToShow && (
                    <div>
                      {runFinished && <span style={{ margin: '40px auto' }}>No graph to show</span>}
                      {!runFinished && (
                        <CircularProgress size={30} className={commonCss.absoluteCenter} />
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Run outputs tab */}
              {selectedTab === 1 && (
                <div className={padding()}>
                  {hasMetrics && (
                    <div>
                      <div className={css.outputTitle}>Metrics</div>
                      <div className={padding(20, 'lt')}>
                        <CompareTable
                          {...CompareUtils.singleRunToMetricsCompareProps(runMetadata, workflow)}
                        />
                      </div>
                    </div>
                  )}
                  {!hasMetrics && <span>No metrics found for this run.</span>}

                  <Separator orientation='vertical' />
                  <Hr />

                  {allArtifactConfigs.map((annotatedConfig, i) => (
                    <div key={i}>
                      <PlotCard
                        key={i}
                        configs={[annotatedConfig.config]}
                        title={annotatedConfig.stepName}
                        maxDimension={400}
                      />
                      <Separator orientation='vertical' />
                      <Hr />
                    </div>
                  ))}
                  {!allArtifactConfigs.length && (
                    <span>No output artifacts found for this run.</span>
                  )}
                </div>
              )}

              {/* Config tab */}
              {selectedTab === 2 && (
                <div className={padding()}>
                  <DetailsTable
                    title='Run details'
                    fields={this._getDetailsFields(workflow, runMetadata)}
                  />

                  {workflowParameters && !!workflowParameters.length && (
                    <div>
                      <DetailsTable
                        title='Run parameters'
                        fields={workflowParameters.map(p => [p.name, p.value || ''])}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }
  getTabNames(workflow: Workflow, selectedNodeId: string): string[] {
    // NOTE: it's only possible to conditionally add a tab at the end
    const tabNameList = [];
    for (let tab in SidePanelTab) {
      // enum iterator will get both number key and string value of all cases.
      // Skip string value because we only switch by numeric key later.
      if (isNaN(Number(tab))) {
        continue;
      }
      // plus symbol changes enum to number.
      switch (+tab) {
        case SidePanelTab.INPUT_OUTPUT: {
          tabNameList.push('Input/Output');
          break;
        }
        case SidePanelTab.VISUALIZATIONS: {
          tabNameList.push('Visualizations');
          break;
        }
        case SidePanelTab.ML_METADATA: {
          if (isV2Pipeline(workflow)) {
            break;
          }
          tabNameList.push('ML Metadata');
          break;
        }
        case SidePanelTab.TASK_DETAILS: {
          tabNameList.push('Details');
          break;
        }
        case SidePanelTab.VOLUMES: {
          tabNameList.push('Volumes');
          break;
        }
        case SidePanelTab.LOGS: {
          tabNameList.push('Logs');
          break;
        }
        case SidePanelTab.POD: {
          tabNameList.push('Pod');
          break;
        }
        case SidePanelTab.EVENTS: {
          tabNameList.push('Events');
          break;
        }
        case SidePanelTab.MANIFEST: {
          if (WorkflowParser.getNodeManifest(workflow, selectedNodeId).length === 0) {
            break;
          }
          tabNameList.push('Manifest');
          break;
        }
        default: {
          console.error(`Unable to find corresponding tab name for ${tab}`);
          break;
        }
      }
    }
    return tabNameList;
  }

  public async componentDidMount(): Promise<void> {
    window.addEventListener('focus', this.onFocusHandler);
    window.addEventListener('blur', this.onBlurHandler);
    await this._startAutoRefresh();
  }

  public onBlurHandler = (): void => {
    this._stopAutoRefresh();
  };

  public onFocusHandler = async (): Promise<void> => {
    await this._startAutoRefresh();
  };

  public componentWillUnmount(): void {
    this._stopAutoRefresh();
    window.removeEventListener('focus', this.onFocusHandler);
    window.removeEventListener('blur', this.onBlurHandler);
    this.clearBanner();
  }

  public async retry(): Promise<void> {
    const runFinished = false;
    this.setStateSafe({
      runFinished,
    });

    await this._startAutoRefresh();
  }

  public async refresh(): Promise<void> {
    await this.load();
  }

  public async load(): Promise<void> {
    this.clearBanner();
    const runId = this.props.match.params[RouteParams.runId];

    try {
      const allowCustomVisualizations = await Apis.areCustomVisualizationsAllowed();
      this.setState({ allowCustomVisualizations });
    } catch (err) {
      this.showPageError('Error: Unable to enable custom visualizations.', err);
    }

    try {
      const runDetail = await Apis.runServiceApi.getRun(runId);

      const relatedExperimentId = RunUtils.getFirstExperimentReferenceId(runDetail.run);
      let experiment: ApiExperiment | undefined;
      let namespace: string | undefined;
      if (relatedExperimentId) {
        experiment = await Apis.experimentServiceApi.getExperiment(relatedExperimentId);
        namespace = RunUtils.getNamespaceReferenceName(experiment);
      }

      const runMetadata = runDetail.run!;

      let runFinished = this.state.runFinished;
      // If the run has finished, stop auto refreshing
      if (hasFinished(runMetadata.status as NodePhase)) {
        this._stopAutoRefresh();
        // This prevents other events, such as onFocus, from resuming the autorefresh
        runFinished = true;
      }

      const jsonWorkflow = JSON.parse(runDetail.pipeline_runtime!.workflow_manifest || '{}');

      if (
        jsonWorkflow.status &&
        !jsonWorkflow.status.nodes &&
        jsonWorkflow.status.compressedNodes
      ) {
        try {
          jsonWorkflow.status.nodes = await decodeCompressedNodes(
            jsonWorkflow.status.compressedNodes,
          );
          delete jsonWorkflow.status.compressedNodes;
        } catch (err) {
          console.error(`Failed to decode compressedNodes: ${err}`);
        }
      }
      const workflow = jsonWorkflow as Workflow;

      // Show workflow errors
      const workflowError = WorkflowParser.getWorkflowError(workflow);
      if (workflowError) {
        if (workflowError === 'terminated') {
          this.props.updateBanner({
            additionalInfo: `This run's workflow included the following message: ${workflowError}`,
            message: 'This run was terminated',
            mode: 'warning',
            refresh: undefined,
          });
        } else {
          this.showPageError(
            `Error: found errors when executing run: ${runId}.`,
            new Error(workflowError),
          );
        }
      }

      let mlmdRunContext: Context | undefined;
      let mlmdExecutions: Execution[] | undefined;
      // Get data about this workflow from MLMD
      try {
        mlmdRunContext = await getRunContext(workflow, runId);
        mlmdExecutions = await getExecutionsFromContext(mlmdRunContext);
      } catch (err) {
        // Data in MLMD may not exist depending on this pipeline is a TFX pipeline.
        // So we only log the error in console.
        logger.warn(err);
      }

      // Build runtime graph
      const graph =
        workflow && workflow.status && workflow.status.nodes
          ? WorkflowParser.createRuntimeGraph(workflow, mlmdExecutions)
          : undefined;
      let reducedGraph = graph
        ? // copy graph before removing edges
          transitiveReduction(graph)
        : undefined;
      if (graph && reducedGraph && compareGraphEdges(graph, reducedGraph)) {
        reducedGraph = undefined; // disable reduction switch
      }

      const breadcrumbs: Array<{ displayName: string; href: string }> = [];
      // If this is an archived run, only show Archive in breadcrumbs, otherwise show
      // the full path, including the experiment if any.
      if (runMetadata.storage_state === ApiRunStorageState.ARCHIVED) {
        breadcrumbs.push({ displayName: 'Archive', href: RoutePage.ARCHIVED_RUNS });
      } else {
        if (experiment) {
          breadcrumbs.push(
            { displayName: 'Experiments', href: RoutePage.EXPERIMENTS },
            {
              displayName: experiment.name!,
              href: RoutePage.EXPERIMENT_DETAILS.replace(
                ':' + RouteParams.experimentId,
                experiment.id!,
              ),
            },
          );
        } else {
          breadcrumbs.push({ displayName: 'All runs', href: RoutePage.RUNS });
        }
      }
      const pageTitle = (
        <div className={commonCss.flex}>
          {statusToIcon(runMetadata.status as NodePhase, runDetail.run!.created_at)}
          <span style={{ marginLeft: 10 }}>{runMetadata.name!}</span>
        </div>
      );

      // Update the Archive/Restore button based on the storage state of this run
      const buttons = new Buttons(
        this.props,
        this.refresh.bind(this),
        this.getInitialToolbarState().actions,
      );
      const idGetter = () => (runMetadata ? [runMetadata!.id!] : []);
      runMetadata!.storage_state === ApiRunStorageState.ARCHIVED
        ? buttons.restore('run', idGetter, true, () => this.refresh())
        : buttons.archive('run', idGetter, true, () => this.refresh());
      const actions = buttons.getToolbarActionMap();
      actions[ButtonKeys.TERMINATE_RUN].disabled =
        (runMetadata.status as NodePhase) === NodePhase.TERMINATING || runFinished;
      // BUG(talebz): AIP-6692 WFSDK: Disable Retry button
      // actions[ButtonKeys.RETRY].disabled =
      //   (runMetadata.status as NodePhase) !== NodePhase.FAILED &&
      //   (runMetadata.status as NodePhase) !== NodePhase.ERROR;
      this.props.updateToolbar({
        actions,
        breadcrumbs,
        pageTitle,
        pageTitleTooltip: runMetadata.name,
      });

      this.setStateSafe({
        experiment,
        graph,
        reducedGraph,
        runFinished,
        runMetadata,
        workflow,
        mlmdRunContext,
        mlmdExecutions,
        namespace,
      });

      // Read optional exeuction id from query parameter. If valid, shows detail of selected node.
      const paramExecutionId = this.props.match.params[RouteParams.executionId];
      if (mlmdExecutions) {
        const selectedExec = mlmdExecutions.find(
          exec => exec.getId().toString() === paramExecutionId,
        );
        if (selectedExec) {
          const selectedNodeId = ExecutionHelpers.getKfpPod(selectedExec);
          if (typeof selectedNodeId === 'string') {
            this.setStateSafe({ selectedNodeDetails: { id: selectedNodeId } });
          }
        }
      }
    } catch (err) {
      await this.showPageError(`Error: failed to retrieve run: ${runId}.`, err);
      logger.error('Error loading run:', runId, err);
    }

    // Make sure logs and artifacts in the side panel are refreshed when
    // the user hits "Refresh", either in the top toolbar or in an error banner.
    await this._loadSidePaneTab(this.state.sidepanelSelectedTab);

    // Load all run's outputs
    await this._loadAllOutputs();
  }

  private handleError = async (error: Error) => {
    await this.showPageError(serviceErrorToString(error), error);
  };

  private async _startAutoRefresh(): Promise<void> {
    // If the run was not finished last time we checked, check again in case anything changed
    // before proceeding to set auto-refresh interval
    if (!this.state.runFinished) {
      // refresh() updates runFinished's value
      await this.refresh();
    }

    // Only set interval if run has not finished, and verify that the interval is undefined to
    // avoid setting multiple intervals
    if (!this.state.runFinished && this._interval === undefined) {
      this._interval = setInterval(() => this.refresh(), this.AUTO_REFRESH_INTERVAL);
    }
  }

  private _stopAutoRefresh(): void {
    if (this._interval !== undefined) {
      clearInterval(this._interval);

      // Reset interval to indicate that a new one can be set
      this._interval = undefined;
    }
  }

  private async _loadAllOutputs(): Promise<void> {
    const workflow = this.state.workflow;

    if (!workflow) {
      return;
    }

    const outputPathsList = WorkflowParser.loadAllOutputPathsWithStepNames(workflow);

    const configLists = await Promise.all(
      outputPathsList.map(({ stepName, path }) =>
        OutputArtifactLoader.load(path, workflow?.metadata?.namespace).then(configs =>
          configs.map(config => ({ config, stepName })),
        ),
      ),
    );
    const allArtifactConfigs = flatten(configLists);

    this.setStateSafe({ allArtifactConfigs });
  }

  private _getDetailsFields(workflow: Workflow, runMetadata?: ApiRun): Array<KeyValue<string>> {
    return !workflow.status
      ? []
      : [
          ['Run ID', runMetadata?.id || '-'],
          ['Workflow name', workflow.metadata?.name || '-'],
          ['Status', workflow.status.phase],
          ['Description', runMetadata ? runMetadata!.description! : ''],
          [
            'Created at',
            workflow.metadata ? formatDateString(workflow.metadata.creationTimestamp) : '-',
          ],
          ['Started at', formatDateString(workflow.status.startedAt)],
          ['Finished at', formatDateString(workflow.status.finishedAt)],
          ['Duration', getRunDurationFromWorkflow(workflow)],
        ];
  }

  private _getTaskDetailsFields(workflow: Workflow, nodeId: string): Array<KeyValue<string>> {
    return workflow?.status?.nodes?.[nodeId]
      ? [
          ['Task ID', workflow.status.nodes[nodeId].id || '-'],
          ['Task name', workflow.status.nodes[nodeId].displayName || '-'],
          ['Status', workflow.status.nodes[nodeId].phase || '-'],
          ['Started at', formatDateString(workflow.status.nodes[nodeId].startedAt) || '-'],
          ['Finished at', formatDateString(workflow.status.nodes[nodeId].finishedAt) || '-'],
          ['Duration', getRunDurationFromNode(workflow, nodeId) || '-'],
        ]
      : [];
  }

  private async _selectNode(id: string): Promise<void> {
    this.setStateSafe(
      { selectedNodeDetails: { id } },
      async () => await this._loadSidePaneTab(this.state.sidepanelSelectedTab),
    );
  }

  private async _loadSidePaneTab(tab: SidePanelTab): Promise<void> {
    const workflow = this.state.workflow;
    const selectedNodeDetails = this.state.selectedNodeDetails;

    let sidepanelBannerMode: Mode = 'warning';

    if (workflow && workflow.status && workflow.status.nodes && selectedNodeDetails) {
      const node = workflow.status.nodes[selectedNodeDetails.id];
      if (node) {
        selectedNodeDetails.phaseMessage =
          node && node.message
            ? `This step is in ${node.phase} state with this message: ` + node.message
            : undefined;

        selectedNodeDetails.phase = node.phase;

        switch (node.phase) {
          // TODO: make distinction between system and pipelines error clear
          case NodePhase.ERROR:
          case NodePhase.FAILED:
            sidepanelBannerMode = 'error';
            break;
          default:
            sidepanelBannerMode = 'info';
            break;
        }
      }
      this.setStateSafe({ selectedNodeDetails, sidepanelSelectedTab: tab, sidepanelBannerMode });

      switch (tab) {
        case SidePanelTab.LOGS:
          if (node.phase !== NodePhase.PENDING && node.phase !== NodePhase.SKIPPED) {
            await this._loadSelectedNodeLogs();
          } else {
            // Clear logs
            this.setStateSafe({ logsBannerAdditionalInfo: '', logsBannerMessage: '' });
          }
      }
    }
  }

  private async _loadSelectedNodeLogs(): Promise<void> {
    const selectedNodeDetails = this.state.selectedNodeDetails;
    const namespace = this.state.workflow?.metadata?.namespace;
    const runId = this.state.runMetadata?.id;
    if (!selectedNodeDetails || !runId || !namespace) {
      return;
    }
    this.setStateSafe({ sidepanelBusy: true });

    let logsBannerMessage = '';
    let logsBannerAdditionalInfo = '';
    let logsBannerMode = '' as Mode;

    try {
      selectedNodeDetails.logs = await Apis.getPodLogs(runId, selectedNodeDetails.id, namespace);
    } catch (err) {
      let errMsg = await errorToMessage(err);
      logsBannerMessage = 'Failed to retrieve pod logs.';

      if (errMsg === 'pod not found') {
        logsBannerMessage += this.props.gkeMetadata.projectId
          ? ' Use Stackdriver Kubernetes Monitoring to view them.'
          : '';
        logsBannerMode = 'info';
        logsBannerAdditionalInfo =
          'Possible reasons include pod garbage collection, cluster autoscaling and pod preemption. ';
      } else {
        logsBannerMode = 'error';
      }

      logsBannerAdditionalInfo += 'Error response: ' + errMsg;
    }

    this.setStateSafe({
      sidepanelBusy: false,
      logsBannerAdditionalInfo,
      logsBannerMessage,
      logsBannerMode,
      selectedNodeDetails,
    });
  }

  private async _onGenerate(
    visualizationArguments: string,
    source: string,
    type: ApiVisualizationType,
    namespace: string,
  ): Promise<void> {
    const nodeId = this.state.selectedNodeDetails ? this.state.selectedNodeDetails.id : '';
    if (nodeId.length === 0) {
      this.showPageError('Unable to generate visualization, no component selected.');
      return;
    }

    if (visualizationArguments.length) {
      try {
        // Attempts to validate JSON, if attempt fails an error is displayed.
        JSON.parse(visualizationArguments);
      } catch (err) {
        this.showPageError('Unable to generate visualization, invalid JSON provided.', err);
        return;
      }
    }
    this.setState({ isGeneratingVisualization: true });
    const visualizationData: ApiVisualization = {
      arguments: visualizationArguments,
      source,
      type,
    };
    try {
      const config = await Apis.buildPythonVisualizationConfig(visualizationData, namespace);
      const { generatedVisualizations } = this.state;
      const generatedVisualization: GeneratedVisualization = {
        config,
        nodeId,
      };
      generatedVisualizations.push(generatedVisualization);
      this.setState({ generatedVisualizations });
    } catch (err) {
      this.showPageError(
        'Unable to generate visualization, an unexpected error was encountered.',
        err,
      );
    } finally {
      this.setState({ isGeneratingVisualization: false });
    }
  }
}

/**
 * Circular progress component. The special real progress vs visual progress
 * logic makes the progress more lively to users.
 *
 * NOTE: onComplete handler should remain its identity, otherwise this component
 * doesn't work well.
 */
const Progress: React.FC<{
  value: number;
  onComplete: () => void;
}> = ({ value: realProgress, onComplete }) => {
  const [visualProgress, setVisualProgress] = React.useState(0);
  React.useEffect(() => {
    let timer: NodeJS.Timeout;

    function tick() {
      if (visualProgress >= 100) {
        clearInterval(timer);
        // After completed, leave some time to show completed progress.
        setTimeout(onComplete, 400);
      } else if (realProgress >= 100) {
        // When completed, fast forward visual progress to complete.
        setVisualProgress(oldProgress => Math.min(oldProgress + 6, 100));
      } else if (visualProgress < realProgress) {
        // Usually, visual progress gradually grows towards real progress.
        setVisualProgress(oldProgress => {
          const step = Math.max(Math.min((realProgress - oldProgress) / 6, 0.01), 0.2);
          return oldProgress < realProgress
            ? Math.min(realProgress, oldProgress + step)
            : oldProgress;
        });
      } else if (visualProgress > realProgress) {
        // Fix visual progress if real progress changed to smaller value.
        // Usually, this shouldn't happen.
        setVisualProgress(realProgress);
      }
    }

    timer = setInterval(tick, 16.6 /* 60fps -> 16.6 ms is 1 frame */);
    return () => {
      clearInterval(timer);
    };
  }, [realProgress, visualProgress, onComplete]);

  return (
    <CircularProgress
      variant='determinate'
      size={60}
      thickness={3}
      className={commonCss.absoluteCenter}
      value={visualProgress}
    />
  );
};

const COMPLETED_NODE_PHASES: ArgoNodePhase[] = ['Succeeded', 'Failed', 'Error'];

// TODO: add unit tests for this.
/**
 * Visualizations tab content component, it handles loading progress state of
 * visualize progress as a circular progress icon.
 */
const VisualizationsTabContent: React.FC<{
  visualizationCreatorConfig: VisualizationCreatorConfig;
  execution?: Execution;
  nodeId: string;
  nodeStatus?: NodeStatus;
  generatedVisualizations: GeneratedVisualization[];
  namespace: string | undefined;
  onError: (error: Error) => void;
}> = ({
  visualizationCreatorConfig,
  generatedVisualizations,
  execution,
  nodeId,
  nodeStatus,
  namespace,
  onError,
}) => {
  const [loaded, setLoaded] = React.useState(false);
  // Progress component expects onLoad function identity to stay the same
  const onLoad = React.useCallback(() => setLoaded(true), [setLoaded]);

  const [progress, setProgress] = React.useState(0);
  const [viewerConfigs, setViewerConfigs] = React.useState<ViewerConfig[]>([]);
  const nodeCompleted: boolean = !!nodeStatus && COMPLETED_NODE_PHASES.includes(nodeStatus.phase);

  React.useEffect(() => {
    let aborted = false;
    async function loadVisualizations() {
      if (aborted) {
        return;
      }
      setLoaded(false);
      setProgress(0);
      setViewerConfigs([]);

      if (!nodeStatus || !nodeCompleted) {
        setProgress(100); // Loaded will be set by Progress onComplete
        return; // Abort, because there is no data.
      }
      // Load runtime outputs from the selected Node
      const outputPaths = WorkflowParser.loadNodeOutputPaths(nodeStatus);
      const reportProgress = (reportedProgress: number) => {
        if (!aborted) {
          setProgress(reportedProgress);
        }
      };
      const reportErrorAndReturnEmpty = (error: Error): [] => {
        onError(error);
        return [];
      };

      // Load the viewer configurations from the output paths
      const builtConfigs = (
        await Promise.all([
          ...(!execution
            ? []
            : [
                OutputArtifactLoader.buildTFXArtifactViewerConfig({
                  reportProgress,
                  execution,
                  namespace: namespace || '',
                }).catch(reportErrorAndReturnEmpty),
              ]),
          ...outputPaths.map(path =>
            OutputArtifactLoader.load(path, namespace).catch(reportErrorAndReturnEmpty),
          ),
        ])
      ).flatMap(configs => configs);
      if (aborted) {
        return;
      }
      setViewerConfigs(builtConfigs);

      setProgress(100); // Loaded will be set by Progress onComplete
      return;
    }
    loadVisualizations();

    const abort = () => {
      aborted = true;
    };
    return abort;
    // Workaround:
    // Watches nodeStatus.phase in completed status instead of nodeStatus,
    // because nodeStatus data won't further change after completed, but
    // nodeStatus object instance will keep changing after new requests to get
    // workflow status.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, execution ? execution.getId() : undefined, nodeCompleted, onError, namespace]);
  // Temporarily use verbose undefined detection instead of execution?.getId() for eslint issue.

  return (
    <div className={commonCss.page}>
      {!loaded ? (
        <Progress value={progress} onComplete={onLoad} />
      ) : (
        <>
          {viewerConfigs.length + generatedVisualizations.length === 0 && (
            <Banner message='There are no visualizations in this step.' mode='info' />
          )}
          {[
            ...viewerConfigs,
            ...generatedVisualizations.map(visualization => visualization.config),
          ].map((config, i) => {
            const title = componentMap[config.type].prototype.getDisplayName();
            return (
              <div key={i} className={padding(20, 'lrt')}>
                <PlotCard configs={[config]} title={title} maxDimension={500} />
                <Hr />
              </div>
            );
          })}
          <div className={padding(20, 'lrt')}>
            <PlotCard
              configs={[visualizationCreatorConfig]}
              title={VisualizationCreator.prototype.getDisplayName()}
              maxDimension={500}
            />
            <Hr />
          </div>
          <div className={padding(20)}>
            <p>
              Add visualizations to your own components following instructions in{' '}
              <ExternalLink href='https://www.kubeflow.org/docs/pipelines/sdk/output-viewer/'>
                Visualize Results in the Pipelines UI
              </ExternalLink>
              .
            </p>
          </div>
        </>
      )}
    </div>
  );
};

const EnhancedRunDetails: React.FC<RunDetailsProps> = props => {
  const namespaceChanged = useNamespaceChangeEvent();
  const gkeMetadata = React.useContext(GkeMetadataContext);
  if (namespaceChanged) {
    // Run details page shows info about a run, when namespace changes, the run
    // doesn't exist in the new namespace, so we should redirect to experiment
    // list page.
    return <Redirect to={RoutePage.EXPERIMENTS} />;
  }
  return <RunDetails {...props} gkeMetadata={gkeMetadata} />;
};

export default EnhancedRunDetails;

export const TEST_ONLY = { RunDetails };
