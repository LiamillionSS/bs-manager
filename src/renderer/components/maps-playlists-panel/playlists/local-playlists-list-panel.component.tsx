import { forwardRef, useCallback, useContext, useImperativeHandle, useMemo, useState } from "react";
import { BsContentLoader } from "renderer/components/shared/bs-content-loader.component";
import { useChangeUntilEqual } from "renderer/hooks/use-change-until-equal.hook";
import { useConstant } from "renderer/hooks/use-constant.hook";
import { useOnUpdate } from "renderer/hooks/use-on-update.hook";
import { useService } from "renderer/hooks/use-service.hook";
import { PlaylistsManagerService } from "renderer/services/playlists-manager.service";
import { FolderLinkState } from "renderer/services/version-folder-linker.service";
import { BehaviorSubject, combineAll, combineLatest, distinctUntilChanged, filter, finalize, lastValueFrom, map, tap } from "rxjs";
import { BSVersion } from "shared/bs-version.interface";
import { noop } from "shared/helpers/function.helpers";
import { LocalBPList, LocalBPListsDetails } from "shared/models/playlists/local-playlist.models";
import { PlaylistItem } from "./playlist-item.component";
import { useStateMap } from "renderer/hooks/use-state-map.hook";
import { ModalExitCode, ModalService } from "renderer/services/modale.service";
import { LocalPlaylistDetailsModal } from "renderer/components/modal/modal-types/playlist/playlist-details-modal/local-playlist-details-modal.component";
import { InstalledMapsContext } from "../maps-playlists-panel.component";
import { IpcService } from "renderer/services/ipc.service";
import equal from "fast-deep-equal";
import { useObservable } from "renderer/hooks/use-observable.hook";
import { PlaylistDownloaderService } from "renderer/services/playlist-downloader.service";
import { NotificationService } from "renderer/services/notification.service";
import { DeletePlaylistModal } from "renderer/components/modal/modal-types/playlist/delete-playlist-modal.component";
import { OsDiagnosticService } from "renderer/services/os-diagnostic.service";
import { PlaylistItemComponentPropsMapper } from "shared/mappers/playlist/playlist-item-component-props.mapper";
import { VirtualScroll } from "renderer/components/shared/virtual-scroll/virtual-scroll.component";
import { LocalPlaylistFilter } from "./local-playlist-filter-panel.component";
import { BsmImage } from "renderer/components/shared/bsm-image.component";
import { BsmButton } from "renderer/components/shared/bsm-button.component";
import BeatConflict from "../../../../../assets/images/apngs/beat-conflict.png";
import { useTranslation } from "renderer/hooks/use-translation.hook";
import { DownloadPlaylistModal } from "renderer/components/modal/modal-types/playlist/download-playlist-modal/download-playlist-modal.component";
import { logRenderError } from "renderer";
import { tryit } from "shared/helpers/error.helpers";
import { ProgressBarService } from "renderer/services/progress-bar.service";
import { ProgressionInterface } from "shared/models/progress-bar";
import { enumerate } from "shared/helpers/array.helpers";
import { SyncPlaylistModal } from "renderer/components/modal/modal-types/playlist/sync-playlist-modal.component";
import { ExportPlaylistModal } from "renderer/components/modal/modal-types/playlist/export-playlist-modal.component";

type Props = {
    version: BSVersion;
    className?: string;
    filter?: LocalPlaylistFilter;
    search?: string;
    linkedState?: FolderLinkState;
    isActive?: boolean;
};

export type LocalPlaylistsListRef = {
    syncPlaylists: () => Promise<void>;
    deletePlaylists: () => Promise<void>;
    exportPlaylists: () => Promise<void>;
}

export const LocalPlaylistsListPanel = forwardRef<LocalPlaylistsListRef, Props>(({ version, className, filter: playlistFiler, search, isActive, linkedState }, forwardedRef) => {

    const t = useTranslation();

    const progess = useService(ProgressBarService);
    const playlistService = useService(PlaylistsManagerService);
    const playlistDownloader = useService(PlaylistDownloaderService);
    const modals = useService(ModalService);
    const ipc = useService(IpcService);
    const osDiagnostic = useService(OsDiagnosticService);
    const notification = useService(NotificationService);

    const isOnline = useObservable(() => osDiagnostic.isOnline$, false);
    const isActiveOnce = useChangeUntilEqual(isActive, { untilEqual: true });

    const { maps$, playlists$, setPlaylists, setMaps } = useContext(InstalledMapsContext);
    const selectedPlaylists$ = useConstant(() => new BehaviorSubject<LocalBPList[]>([]));

    const playlists = useObservable(() => playlists$, []);

    console.log(playlists);

    const [playlistsLoading, setPlaylistsLoading] = useState(false);
    const loadPercent$ = useConstant(() => new BehaviorSubject<number>(0));
    const linked = useStateMap(linkedState, (newState, precMapped) => (newState === FolderLinkState.Pending || newState === FolderLinkState.Processing) ? precMapped : newState === FolderLinkState.Linked, false);

    const installPlaylist = (playlist: LocalBPList) => {
        const ignoreSongsHashs = (maps$.value || []).map(m => m.hash.toLocaleLowerCase());
        return playlistDownloader.downloadPlaylist({ downloadSource: playlist.customData?.syncURL ?? playlist.path, version, ignoreSongsHashs, dest: playlist.path });
    }

    useImperativeHandle(forwardedRef, () => ({
        syncPlaylists: async () => {
            if(!isOnline){ return; }
            const toSync = selectedPlaylists$.value?.length ? selectedPlaylists$.value : playlists$.value;
            if(!toSync.length){ return; }

            const modalRes = await modals.openModal(SyncPlaylistModal, { data: toSync });
            if(modalRes.exitCode !== ModalExitCode.COMPLETED){ return; }

            const obs$ = combineLatest(toSync.map(playlist => installPlaylist(playlist)));

            const { error, result } = await tryit(() => lastValueFrom(obs$));

            if(error){
                logRenderError("Error occured while synchronizing playlists", error);
                notification.notifyError({ title: "Erreur lors de la synchronisation des playlists", desc: "Une erreur est survenue lors de la synchronisation des playlists." });
                return;
            }

            if(result.every(res => res.current === res.total)){
                notification.notifySuccess({ title: "Playlists synchronisées !", desc: "Les playlists et leurs maps ont été téléchargées.", duration: 5000 });
            }
        },
        exportPlaylists: async () => {
            if(!progess.require()){ return; }
            const toExport = selectedPlaylists$.value?.length ? selectedPlaylists$.value : playlists$.value;

            if(!toExport.length){ return; }

            const modalRes = await modals.openModal(ExportPlaylistModal, { data: toExport });
            if(modalRes.exitCode !== ModalExitCode.COMPLETED){ return; }

            const folderRes = await lastValueFrom(ipc.sendV2("choose-folder"));
            if(!folderRes || folderRes.canceled || !folderRes.filePaths?.length){ return; }

            if(modalRes.exitCode !== ModalExitCode.COMPLETED){ return; }
            const obs$ = playlistService.exportPlaylists({ version, bpLists: toExport, dest: folderRes.filePaths.at(0), exportMaps: modalRes.data });

            progess.show(obs$, true);

            const { error } = await tryit(() => lastValueFrom(obs$));

            if(error){
                logRenderError("Error occured while exporting playlists", error);
                notification.notifyError({ title: "Erreur lors de l'exportation des playlists", desc: "Une erreur est survenue lors de l'exportation des playlists." });
                return;
            }

            notification.notifySuccess({ title: "Playlists exportées !", desc: "Les playlists et leurs maps ont été exportées.", duration: 5000 });

            progess.hide(true);
        },
        deletePlaylists: () => {
            const toDelete = selectedPlaylists$.value?.length ? selectedPlaylists$.value : playlists$.value;
            if(!toDelete.length){ return Promise.resolve(); }
            return deletePlaylists(toDelete);
        }
    }))

    const loadLocalPlaylistsDetails = (): Promise<LocalBPListsDetails[]> => {
        setPlaylistsLoading(true);
        const obs = playlistService.getVersionPlaylistsDetails(version).pipe(
            tap({ next: load => loadPercent$.next((load.current / load.total) * 100)}),
            map(load => load.data),
            finalize(() => setPlaylistsLoading(false))
        );

        return lastValueFrom(obs);
    }

    useOnUpdate(() => {

        if(!isActiveOnce){ return noop(); }

        loadLocalPlaylistsDetails().then(loadedPlaylists => {
            setPlaylists(loadedPlaylists);
        }).catch(() => {
            setPlaylists([]);
        }).finally(() => {
            loadPercent$.next(0);
        });

        const onPlaylistDownloadedCB = (downloaded: LocalBPListsDetails) => {
            const newPlaylist = (() => {
                const index = playlists$.value.findIndex(p => p.path === downloaded.path);
                if(index === -1){
                    return [...playlists$.value, downloaded];
                }

                const newPlaylists = [...playlists$.value];
                newPlaylists[index] = downloaded;
                return newPlaylists;
            })();
            setPlaylists(newPlaylist);
        }

        const sub = playlistDownloader.currentDownload$.pipe(filter(download => download?.downloaded && equal(download?.info.version, version))).subscribe(download => onPlaylistDownloadedCB(download.downloaded));

        return () => {
            sub.unsubscribe();
        }

    }, [isActiveOnce, version, linked]);

    const openDownloadPlaylistModal = () => {
        modals.openModal(DownloadPlaylistModal, { data: { version, ownedPlaylists$: playlists$, ownedMaps$: maps$ } });
    }

    const handleClickSync = (playlist: LocalBPList) => {

        const obs$ = installPlaylist(playlist);

        return lastValueFrom(obs$).then(res => {
            if(res.current === res.total){
                notification.notifySuccess({ title: "Playlist synchronisée !", desc: "La playlist et ses maps on été téléchargées.", duration: 5000 })
            }
        });
    }

    const viewPlaylistFile = (path: string) => {
        return lastValueFrom(ipc.sendV2("view-path-in-explorer", path));
    };

    const deletePlaylists = async (bpLists: LocalBPList[]) => {

        if(!bpLists.length || !progess.require()){ return; }

        const { exitCode, data: deleteMaps } = await modals.openModal(DeletePlaylistModal, { data: bpLists });

        if(exitCode !== ModalExitCode.COMPLETED){ return; }

        const progess$ = new BehaviorSubject<ProgressionInterface>({ progression: 0 });
        progess.show(progess$, true)

        for(const [i, bpList] of enumerate(bpLists)){

            const { error } = await tryit(() => lastValueFrom(playlistService.deletePlaylist({ version, bpList, deleteMaps })))

            if(error){
                logRenderError("Error occured while deleting playlist", error);
                notification.notifyError({ title: "Erreur lors de la suppression de la playlist", desc: "Une erreur est survenue lors de la suppression de la playlist." });
                progess.hide(true);
                return;
            }

            progess$.next({ progression: (i / bpLists.length) * 100, label: bpList.playlistTitle });
            setPlaylists(playlists$.value.filter(p => p.path !== bpList.path));

            if(deleteMaps){
                setMaps(maps$.value.filter(m => !bpList.songs.some(s => s.hash.toLocaleLowerCase() === m.hash.toLocaleLowerCase())));
            }
        }

        progess.hide(true);
    };

    const openPlaylistDetails = (playlistPath: string) => {
        const localPlaylist$ = playlists$.pipe(map(playlists => playlists.find(p => p.path === playlistPath)));
        const installedMaps$ = combineLatest([maps$, localPlaylist$]).pipe(
            filter(([maps, playlist]) => !!maps && !!playlist),
            map(([maps, playlist]) => maps.filter(m => playlist.songs.some(song => song.hash.toLocaleLowerCase() === m.hash.toLocaleLowerCase()))),
            distinctUntilChanged(equal)
        );

        modals.openModal(LocalPlaylistDetailsModal, {
            data: { version, localPlaylist$, installedMaps$ },
            noStyle: true,
        })
    };

    const renderPlaylist = useCallback((playlist: LocalBPListsDetails) => {


        return (
            <PlaylistItem
                key={playlist.path}
                {...PlaylistItemComponentPropsMapper.fromLocalBPListDetails(playlist)}
                isDownloading$={playlistDownloader.$isPlaylistDownloading(playlist.customData?.syncURL ?? playlist.path, version)}
                isInQueue$={playlistDownloader.$isPlaylistInQueue(playlist.customData?.syncURL ?? playlist.path, version)}
                selected$={selectedPlaylists$.pipe(map(selected => selected.some(s => s.path === playlist.path)), distinctUntilChanged(equal))}
                onClick={() => {
                    console.log(selectedPlaylists$.value, playlist.path);
                    if(selectedPlaylists$.value.some(s => s.path === playlist.path)){
                        selectedPlaylists$.next(selectedPlaylists$.value.filter(s => s.path !== playlist.path));
                        return;
                    }

                    selectedPlaylists$.next([...selectedPlaylists$.value, playlist]);
                }}
                onClickOpen={() => openPlaylistDetails(playlist.path)}
                onClickDelete={() => deletePlaylists([playlist])}
                onClickSync={isOnline && (() => handleClickSync(playlist))}
                onClickOpenFile={() => viewPlaylistFile(playlist.path)}
                onClickCancelDownload={() => playlistDownloader.cancelDownload(playlist.customData?.syncURL ?? playlist.path, version)}
            />
        );
    }, [isOnline, version]);

    const filteredPlaylists = useMemo(() => {
        if(!playlists){ return []; }

        return playlists.filter(p => {
            if(!p.playlistTitle.toLocaleLowerCase().includes(search.toLocaleLowerCase())){ return false; }
            if(!p.playlistAuthor.toLocaleLowerCase().includes(search.toLocaleLowerCase())){ return false; }

            if(typeof p.nbMaps === "number" && (typeof playlistFiler?.minNbMaps === "number" || typeof playlistFiler?.maxNbMaps === "number")){
                if(playlistFiler?.minNbMaps && p.nbMaps < playlistFiler.minNbMaps){ return false; }
                if(playlistFiler?.maxNbMaps && p.nbMaps > playlistFiler.maxNbMaps){ return false; }
            }

            if(typeof p.nbMappers === "number" && (typeof playlistFiler?.minNbMappers === "number" || typeof playlistFiler?.maxNbMappers === "number")){
                if(playlistFiler?.minNbMappers && p.nbMappers < playlistFiler.minNbMappers){ return false; }
                if(playlistFiler?.maxNbMappers && p.nbMappers > playlistFiler.maxNbMappers){ return false; }
            }

            if(typeof p.duration === "number" && (typeof playlistFiler?.minDuration === "number" || typeof playlistFiler?.maxDuration === "number")){
                if(playlistFiler?.minDuration && p.duration < playlistFiler.minDuration){ return false; }
                if(playlistFiler?.maxDuration && p.duration > playlistFiler.maxDuration){ return false; }
            }

            if(typeof p.minNps === "number" && typeof playlistFiler.minNps === "number" && p.minNps < playlistFiler.minNps){ return false; }
            if(typeof p.maxNps === "number" && typeof playlistFiler.maxNps === "number" && p.maxNps > playlistFiler.maxNps){ return false; }

            return true;
        });
    }, [playlists, search, playlistFiler]);

    return (
        <div className={className}>
            {(() => {
                if(playlistsLoading){
                    return (
                        <BsContentLoader className="w-full h-full flex justify-center flex-col items-center" value$={loadPercent$} text="Chargement des playlists"/>
                    )
                }

                if (filteredPlaylists?.length){
                    return (
                        <VirtualScroll
                            classNames={{
                                mainDiv: "size-full",
                                rows: "gap-2 px-2 py-2"
                            }}
                            itemHeight={120}
                            maxColumns={4}
                            minItemWidth={390}
                            items={filteredPlaylists}
                            renderItem={renderPlaylist}
                        />
                    )
                }

                return (
                    <div className="h-full flex flex-col items-center justify-center flex-wrap gap-1 text-gray-800 dark:text-gray-200">
                        <BsmImage className="h-32" image={BeatConflict} />
                        <span className="font-bold">Aucune playlist</span>
                        <BsmButton
                            className="font-bold rounded-md p-2"
                            text="Télécharger des playlists"
                            typeColor="primary"
                            withBar={false}
                            onClick={e => {
                                e.preventDefault();
                                openDownloadPlaylistModal();
                            }}
                        />
                    </div>
                );
            })()}
        </div>
    )
});
