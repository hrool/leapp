import {Component, Input, OnInit, TemplateRef, ViewChild} from '@angular/core';
import {Session} from '../../../models/session';
import {AwsSessionService} from '../../../services/aws-session.service';
import {AppService, LoggerLevel, ToastLevel} from '../../../services/app.service';
import {Router} from '@angular/router';
import {AwsFederatedSession} from '../../../models/aws-federated-session';
import {SsmService} from '../../../services/ssm.service';
import {SessionType} from '../../../models/session-type';
import {WorkspaceService} from '../../../services/workspace.service';
import {environment} from '../../../../environments/environment';
import {KeychainService} from '../../../services/keychain.service';
import * as uuid from 'uuid';
import {BsModalRef, BsModalService} from 'ngx-bootstrap/modal';
import {FileService} from '../../../services/file.service';
import {SessionFactoryService} from '../../../services/session-factory.service';
import {SessionStatus} from '../../../models/session-status';
import {SessionService} from '../../../services/session.service';

@Component({
  selector: 'app-session-card',
  templateUrl: './session-card.component.html',
  styleUrls: ['./session-card.component.scss'],

})
export class SessionCardComponent implements OnInit {

  @Input()
  session!: Session;

  @ViewChild('ssmModalTemplate', { static: false })
  ssmModalTemplate: TemplateRef<any>;

  @ViewChild('defaultRegionModalTemplate', { static: false })
  defaultRegionModalTemplate: TemplateRef<any>;

  @ViewChild('defaultProfileModalTemplate', { static: false })
  defaultProfileModalTemplate: TemplateRef<any>;

  eSessionType = SessionType;
  eSessionStatus = SessionStatus;

  modalRef: BsModalRef;

  ssmLoading = true;
  selectedSsmRegion;
  selectedDefaultRegion;
  openSsm = false;
  awsRegions = [];
  regionOrLocations = [];
  instances = [];
  duplicateInstances = [];
  placeholder;
  selectedProfile: any;
  profiles: { id: string; name: string }[];

  // Generated by the factory
  private sessionService: SessionService;

  constructor(private workspaceService: WorkspaceService,
              private keychainService: KeychainService,
              private appService: AppService,
              private fileService: FileService,
              private router: Router,
              private ssmService: SsmService,
              private sessionProviderService: SessionFactoryService,
              private modalService: BsModalService) {}

  ngOnInit() {
    // Generate a singleton service for the concrete implementation of SessionService
    this.sessionService = this.sessionProviderService.getService(this.session.type);

    // Set regions and locations
    this.awsRegions = this.appService.getRegions();
    const azureLocations = this.appService.getLocations();

    // Get profiles
    this.profiles = this.workspaceService.get().profiles;

    // Array and labels for regions and locations
    this.regionOrLocations = this.session.type !== SessionType.azure ? this.awsRegions : azureLocations;
    this.placeholder = this.session.type !== SessionType.azure ? 'Select a default region' : 'Select a default location';

    // Pre selected Region and Profile
    this.selectedDefaultRegion = this.session.region;
    this.selectedProfile = this.getProfileId(this.session);
  }

  /**
   * Used to call for start or stop depending on session status
   */
  switchCredentials() {
    if (this.session.status === SessionStatus.active) {
      this.stopSession();
    } else {
      this.startSession();
    }
  }

  /**
   * Start the selected session
   */
  startSession() {
    this.sessionService.start(this.session.sessionId);
    this.logSessionData(this.session, `Starting Session`);
  }

  /**
   * Stop session
   */
  stopSession() {
    this.sessionService.stop(this.session.sessionId);
    this.logSessionData(this.session, `Stopped Session`);
  }

  /**
   * Delete a session from the workspace
   *
   * @param session - the session to remove
   * @param event - for stopping propagation bubbles
   */
  deleteSession(session, event) {
    event.stopPropagation();

    const dialogMessage = this.generateDeleteDialogMessage(session);

    this.appService.confirmDialog(dialogMessage, () => {
      this.sessionService.delete(session.sessionId);
      this.logSessionData(session, 'Session Deleted');
    });
  }


  /**
   * Edit Session
   *
   * @param session - the session to edit
   * @param event - to remove propagation bubbles
   */
  editSession(session, event) {
    event.stopPropagation();
    this.router.navigate(['/managing', 'edit-account'], {queryParams: { sessionId: session.id }});
  }

  /**
   * Copy credentials in the clipboard
   */
  copyCredentials(session: Session, type: number, event) {
    event.stopPropagation();
    try {
      const workspace = this.workspaceService.get();
      if (workspace) {
        const texts = {
          1: (session as AwsFederatedSession).roleArn ? `${(session as AwsFederatedSession).roleArn.split('/')[0].substring(13, 25)}` : '',
          2: (session as AwsFederatedSession).roleArn ? `${(session as AwsFederatedSession).roleArn}` : ''
        };

        const text = texts[type];

        this.appService.copyToClipboard(text);
        this.appService.toast('Your information have been successfully copied!', ToastLevel.success, 'Information copied!');
      }
    } catch (err) {
      this.appService.toast(err, ToastLevel.warn);
      this.appService.logger(err, LoggerLevel.error, this, err.stack);
    }
  }

  // ============================== //
  // ========== SSM AREA ========== //
  // ============================== //
  addNewProfile(tag: string) {
    return {id: uuid.v4(), name: tag};
  }

  /**
   * SSM Modal open given the correct session
   *
   * @param session - the session to check for possible ssm sessions
   */
  ssmModalOpen(session) {
    // Reset things before opening the modal
    this.instances = [];
    this.ssmLoading = false;
    this.modalRef = this.modalService.show(this.ssmModalTemplate, { class: 'ssm-modal'});
  }

  /**
   * SSM Modal open given the correct session
   *
   * @param session - the session to check for possible ssm sessions
   */
  changeRegionModalOpen(session) {
    // open the modal
    this.modalRef = this.modalService.show(this.defaultRegionModalTemplate, { class: 'ssm-modal'});
  }

  /**
   * Set the region for ssm init and launch the mopethod form the server to find instances
   *
   * @param event - the change select event
   * @param session - The session in which the AWS region need to change
   */
  async changeSsmRegion(event, session: Session) {
    // We have a valid SSM region
    if (this.selectedSsmRegion) {
      // Start process
      this.ssmLoading = true;
      // Generate valid temporary credentials for the SSM and EC2 client
      const credentials = await (this.sessionService as AwsSessionService).generateCredentials(session.sessionId);
      // Get the instances
      this.instances = await this.ssmService.getSsmInstances(credentials, this.selectedSsmRegion);
      this.duplicateInstances = this.instances;
      this.ssmLoading = false;
    }
  }

  /**
   * Set the region for the session
   */
  async changeRegion() {
    if (this.selectedDefaultRegion) {
      // If there is a valid region to change
      if (this.session.status === SessionStatus.active) {
        // Stop temporary if the session is active
        await this.sessionService.stop(this.session.sessionId);
      }

      this.session.region = this.selectedDefaultRegion;
      this.sessionService.update(this.session.sessionId, this.session);

      if (this.session.status === SessionStatus.active) {
        this.startSession();
      }

      this.appService.toast('Default region has been changed!', ToastLevel.success, 'Region changed!');
      this.modalRef.hide();
    }
  }

  /**
   * Start a new ssm session
   *
   * @param instanceId - instance id to start ssm session
   */
  startSsmSession(instanceId) {
    this.instances.forEach(instance => {
     if (instance.InstanceId === instanceId) {
       instance.loading = true;
     }
    });

    this.ssmService.startSession(instanceId, this.selectedSsmRegion);

    setTimeout(() => {
      this.instances.forEach(instance => {
       if (instance.InstanceId === instanceId) {
          instance.loading = false;
       }
      });
    }, 4000);

    this.openSsm = false;
    this.ssmLoading = false;
  }

  searchSSMInstance(event) {
    if (event.target.value !== '') {
      this.instances = this.duplicateInstances.filter(i =>
                                 i.InstanceId.indexOf(event.target.value) > -1 ||
                                 i.IPAddress.indexOf(event.target.value) > -1 ||
                                 i.Name.indexOf(event.target.value) > -1);
    } else {
      this.instances = this.duplicateInstances;
    }
  }

  getProfileId(session: Session): string {
    if(session.type !== SessionType.azure) {
      return (session as any).profileId;
    } else {
      return undefined;
    }
  }

  getProfileName(profileId: string): string {
    const profileName = this.workspaceService.getProfileName(profileId);
    return profileName ? profileName : environment.defaultAwsProfileName;
  }

  async changeProfile() {
    if (this.selectedProfile) {
      if (this.session.status === SessionStatus.active) {
        await this.sessionService.stop(this.session.sessionId);
      }

      console.log(this.selectedProfile);

      if(!this.workspaceService.getProfileName(this.selectedProfile.id)) {
        this.workspaceService.addProfile(this.selectedProfile);
      }

      (this.session as any).profileId = this.selectedProfile.id;
      this.sessionService.update(this.session.sessionId, this.session);

      if (this.session.status === SessionStatus.active) {
        this.startSession();
      }

      this.appService.toast('Profile has been changed!', ToastLevel.success, 'Profile changed!');
      this.modalRef.hide();
    }
  }

  changeProfileModalOpen() {
    this.selectedProfile = null;
    this.modalRef = this.modalService.show(this.defaultProfileModalTemplate, { class: 'ssm-modal'});
  }

  /**
   * Close modals
   */
  goBack() {
    this.modalRef.hide();
  }

  private logSessionData(session: Session, message: string): void {
    this.appService.logger(
      message,
      LoggerLevel.info,
      this,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        id: session.sessionId,
        account: session.sessionName,
        type: session.type
      }, null, 3));
  }

  private generateDeleteDialogMessage(session: Session): string {
    let trusterSessions = [];
    if (session.type !== SessionType.azure) {
      trusterSessions = (this.sessionService as AwsSessionService).listTruster(session);
    }

    let trusterSessionString = '';
    trusterSessions.forEach(sess => {
      trusterSessionString += `<li><div class="removed-sessions"><b>${sess.sessionName}</b></div></li>`;
    });
    if (trusterSessionString !== '') {
      return 'This session has truster sessions: <br><ul>' +
        trusterSessionString +
        '</ul><br>Removing the session will also remove the truster session associated with it. Do you want to proceed?';
    } else {
      return 'Do you really want to delete this session?';
    }
  }
}
