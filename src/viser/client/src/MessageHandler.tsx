import { notifications } from "@mantine/notifications";

import React, { useContext } from "react";
import * as THREE from "three";
import { TextureLoader } from "three";

import { ViewerContext } from "./App";
import {
  FileTransferPart,
  FileTransferStart,
  Message,
  SceneNodeMessage,
  isGuiComponentMessage,
  isSceneNodeMessage,
} from "./WebsocketMessages";
import { isTexture } from "./WebsocketFunctions";
import { useFrame } from "@react-three/fiber";
import { Progress } from "@mantine/core";
import { IconCheck } from "@tabler/icons-react";
import { computeT_threeworld_world } from "./WorldTransformUtils";
import { rootNodeTemplate } from "./SceneTreeState";

/** Returns a handler for all incoming messages. */
function useMessageHandler() {
  const viewer = useContext(ViewerContext)!;

  // We could reduce the redundancy here if we wanted to.
  // https://github.com/nerfstudio-project/viser/issues/39
  const updateSceneNode = viewer.useSceneTree((state) => state.updateSceneNode);
  const removeSceneNode = viewer.useSceneTree((state) => state.removeSceneNode);
  const resetScene = viewer.useSceneTree((state) => state.resetScene);
  const addSceneNode = viewer.useSceneTree((state) => state.addSceneNode);
  const resetGui = viewer.useGui((state) => state.resetGui);
  const setTheme = viewer.useGui((state) => state.setTheme);
  const setShareUrl = viewer.useGui((state) => state.setShareUrl);
  const addGui = viewer.useGui((state) => state.addGui);
  const addModal = viewer.useGui((state) => state.addModal);
  const removeModal = viewer.useGui((state) => state.removeModal);
  const removeGui = viewer.useGui((state) => state.removeGui);
  const updateGuiProps = viewer.useGui((state) => state.updateGuiProps);
  const setClickable = viewer.useSceneTree((state) => state.setClickable);
  const updateUploadState = viewer.useGui((state) => state.updateUploadState);

  // Same as addSceneNode, but make a parent in the form of a dummy coordinate
  // frame if it doesn't exist yet.
  function addSceneNodeMakeParents(message: SceneNodeMessage) {
    // Make sure scene node is in attributes.
    const attrs = viewer.nodeAttributesFromName.current;
    attrs[message.name] = {
      overrideVisibility: attrs[message.name]?.overrideVisibility,
    };

    // Don't update the pose of the object until we've made a new one!
    attrs[message.name]!.poseUpdateState = "waitForMakeObject";

    // Make sure parents exists.
    const nodeFromName = viewer.useSceneTree.getState().nodeFromName;
    const parentName = message.name.split("/").slice(0, -1).join("/");
    if (!(parentName in nodeFromName)) {
      addSceneNodeMakeParents({
        ...rootNodeTemplate.message,
        name: parentName,
      });
    }
    addSceneNode(message);
  }

  const fileDownloadHandler = useFileDownloadHandler();

  // Return message handler.
  return (message: Message) => {
    if (isGuiComponentMessage(message)) {
      addGui(message);
      return;
    }

    if (isSceneNodeMessage(message)) {
      // Initialize skinned mesh state.
      if (message.type === "SkinnedMeshMessage") {
        viewer.skinnedMeshState.current[message.name] = {
          initialized: false,
          poses: [],
        };

        const bone_wxyzs = new Float32Array(
          message.props.bone_wxyzs.buffer.slice(
            message.props.bone_wxyzs.byteOffset,
            message.props.bone_wxyzs.byteOffset +
              message.props.bone_wxyzs.byteLength,
          ),
        );
        const bone_positions = new Float32Array(
          message.props.bone_positions.buffer.slice(
            message.props.bone_positions.byteOffset,
            message.props.bone_positions.byteOffset +
              message.props.bone_positions.byteLength,
          ),
        );
        for (let i = 0; i < message.props.bone_wxyzs!.length; i++) {
          viewer.skinnedMeshState.current[message.name].poses.push({
            wxyz: [
              bone_wxyzs[4 * i],
              bone_wxyzs[4 * i + 1],
              bone_wxyzs[4 * i + 2],
              bone_wxyzs[4 * i + 3],
            ],
            position: [
              bone_positions[3 * i],
              bone_positions[3 * i + 1],
              bone_positions[3 * i + 2],
            ],
          });
        }
      }

      // Add scene node.
      addSceneNodeMakeParents(message);
      return;
    }

    switch (message.type) {
      case "SceneNodeUpdateMessage": {
        updateSceneNode(message.name, message.updates);
        return;
      }
      // Set the share URL.
      case "ShareUrlUpdated": {
        setShareUrl(message.share_url);
        return;
      }
      // Request a render.
      case "GetRenderRequestMessage": {
        viewer.getRenderRequest.current = message;
        viewer.getRenderRequestState.current = "triggered";
        return;
      }
      // Set the GUI panel label.
      case "SetGuiPanelLabelMessage": {
        viewer.useGui.setState({ label: message.label ?? "" });
        return;
      }
      // Configure the theme.
      case "ThemeConfigurationMessage": {
        setTheme(message);
        return;
      }

      // Run some arbitrary Javascript.
      // This is used for plotting, where the Python server will send over a
      // copy of plotly.min.js for the currently-installed version of plotly.
      case "RunJavascriptMessage": {
        eval(message.source);
        return;
      }

      // Add a notification.
      case "NotificationMessage": {
        (message.mode === "show" ? notifications.show : notifications.update)({
          id: message.uuid,
          title: message.props.title,
          message: message.props.body,
          withCloseButton: message.props.with_close_button,
          loading: message.props.loading,
          autoClose: message.props.auto_close,
          color: message.props.color ?? undefined,
        });
        return;
      }

      // Remove a specific notification.
      case "RemoveNotificationMessage": {
        notifications.hide(message.uuid);
        return;
      }
      // Enable/disable whether scene pointer events are sent.
      case "ScenePointerEnableMessage": {
        // Update scene click enable state.
        viewer.scenePointerInfo.current!.enabled = message.enable
          ? message.event_type
          : false;

        // Update cursor to indicate whether the scene can be clicked.
        viewer.canvasRef.current!.style.cursor = message.enable
          ? "pointer"
          : "auto";
        return;
      }

      // Add an environment map
      case "EnvironmentMapMessage": {
        viewer.useSceneTree.setState({ environmentMap: message });
        return;
      }

      // Disable/enable default lighting
      case "EnableLightsMessage": {
        viewer.useSceneTree.setState({ enableDefaultLights: message.enabled });
        return;
      }

      case "GuiModalMessage": {
        addModal(message);
        return;
      }

      case "GuiCloseModalMessage": {
        removeModal(message.uuid);
        return;
      }

      // Set the bone poses.
      case "SetBoneOrientationMessage": {
        const state = viewer.skinnedMeshState.current;
        state[message.name].poses[message.bone_index].wxyz = message.wxyz;
        break;
      }
      case "SetBonePositionMessage": {
        const state = viewer.skinnedMeshState.current;
        state[message.name].poses[message.bone_index].position =
          message.position;
        break;
      }
      case "SetCameraLookAtMessage": {
        const cameraControls = viewer.cameraControlRef.current!;

        const T_threeworld_world = computeT_threeworld_world(viewer);
        const target = new THREE.Vector3(
          message.look_at[0],
          message.look_at[1],
          message.look_at[2],
        );
        target.applyMatrix4(T_threeworld_world);
        cameraControls.setTarget(target.x, target.y, target.z, false);
        return;
      }
      case "SetCameraUpDirectionMessage": {
        const camera = viewer.cameraRef.current!;
        const cameraControls = viewer.cameraControlRef.current!;
        const T_threeworld_world = computeT_threeworld_world(viewer);
        const updir = new THREE.Vector3(
          message.position[0],
          message.position[1],
          message.position[2],
        )
          .normalize()
          .applyQuaternion(
            new THREE.Quaternion().setFromRotationMatrix(T_threeworld_world),
          );
        camera.up.set(updir.x, updir.y, updir.z);

        // Back up position.
        const prevPosition = new THREE.Vector3();
        cameraControls.getPosition(prevPosition);

        cameraControls.updateCameraUp();

        // Restore position, which can get unexpectedly mutated in updateCameraUp().
        cameraControls.setPosition(
          prevPosition.x,
          prevPosition.y,
          prevPosition.z,
          false,
        );
        return;
      }
      case "SetCameraPositionMessage": {
        const cameraControls = viewer.cameraControlRef.current!;

        // Set the camera position. Due to the look-at, note that this will
        // shift the orientation as-well.
        const position_cmd = new THREE.Vector3(
          message.position[0],
          message.position[1],
          message.position[2],
        );

        const T_threeworld_world = computeT_threeworld_world(viewer);
        position_cmd.applyMatrix4(T_threeworld_world);

        cameraControls.setPosition(
          position_cmd.x,
          position_cmd.y,
          position_cmd.z,
        );
        return;
      }
      case "SetCameraFovMessage": {
        const camera = viewer.cameraRef.current!;
        // tan(fov / 2.0) = 0.5 * film height / focal length
        // focal length = 0.5 * film height / tan(fov / 2.0)
        camera.setFocalLength(
          (0.5 * camera.getFilmHeight()) / Math.tan(message.fov / 2.0),
        );
        viewer.sendCameraRef.current !== null && viewer.sendCameraRef.current();
        return;
      }
      case "SetOrientationMessage": {
        const attr = viewer.nodeAttributesFromName.current;
        if (attr[message.name] === undefined) attr[message.name] = {};
        attr[message.name]!.wxyz = message.wxyz;
        if (attr[message.name]!.poseUpdateState == "updated")
          attr[message.name]!.poseUpdateState = "needsUpdate";
        break;
      }
      case "SetPositionMessage": {
        const attr = viewer.nodeAttributesFromName.current;
        if (attr[message.name] === undefined) attr[message.name] = {};
        attr[message.name]!.position = message.position;
        if (attr[message.name]!.poseUpdateState == "updated")
          attr[message.name]!.poseUpdateState = "needsUpdate";
        break;
      }
      case "SetSceneNodeVisibilityMessage": {
        const attr = viewer.nodeAttributesFromName.current;
        if (attr[message.name] === undefined) attr[message.name] = {};
        attr[message.name]!.visibility = message.visible;
        break;
      }
      // Add a background image.
      case "BackgroundImageMessage": {
        const rgb_url = URL.createObjectURL(
          new Blob([message.rgb_bytes], {
            type: message.media_type,
          }),
        );
        new TextureLoader().load(rgb_url, (texture) => {
          URL.revokeObjectURL(rgb_url);
          const oldBackgroundTexture =
            viewer.backgroundMaterialRef.current!.uniforms.colorMap.value;
          viewer.backgroundMaterialRef.current!.uniforms.colorMap.value =
            texture;
          if (isTexture(oldBackgroundTexture)) oldBackgroundTexture.dispose();

          viewer.useGui.setState({ backgroundAvailable: true });
        });
        viewer.backgroundMaterialRef.current!.uniforms.enabled.value = true;
        viewer.backgroundMaterialRef.current!.uniforms.hasDepth.value =
          message.depth_bytes !== null;

        if (message.depth_bytes !== null) {
          // If depth is available set the texture
          const depth_url = URL.createObjectURL(
            new Blob([message.depth_bytes], {
              type: message.media_type,
            }),
          );
          new TextureLoader().load(depth_url, (texture) => {
            URL.revokeObjectURL(depth_url);
            const oldDepthTexture =
              viewer.backgroundMaterialRef.current?.uniforms.depthMap.value;
            viewer.backgroundMaterialRef.current!.uniforms.depthMap.value =
              texture;
            if (isTexture(oldDepthTexture)) oldDepthTexture.dispose();
          });
        }
        return;
      }
      // Remove a scene node and its children by name.
      case "RemoveSceneNodeMessage": {
        console.log("Removing scene node:", message.name);
        const nodeFromName = viewer.useSceneTree.getState().nodeFromName;
        if (!(message.name in nodeFromName)) {
          console.log("Skipping scene node removal for " + name);
          return;
        }
        removeSceneNode(message.name);
        const attrs = viewer.nodeAttributesFromName.current;
        delete attrs[message.name];

        if (viewer.skinnedMeshState.current[message.name] !== undefined)
          delete viewer.skinnedMeshState.current[message.name];
        return;
      }
      // Set the clickability of a particular scene node.
      case "SetSceneNodeClickableMessage": {
        // This setTimeout is totally unnecessary, but can help surface some race
        // conditions.
        setTimeout(() => setClickable(message.name, message.clickable), 50);
        return;
      }
      // Reset the entire scene, removing all scene nodes.
      case "ResetSceneMessage": {
        resetScene();

        const oldBackground = viewer.sceneRef.current?.background;
        viewer.sceneRef.current!.background = null;
        if (isTexture(oldBackground)) oldBackground.dispose();

        viewer.useGui.setState({ backgroundAvailable: false });
        // Disable the depth texture rendering
        viewer.backgroundMaterialRef.current!.uniforms.enabled.value = false;
        return;
      }
      // Reset the GUI state.
      case "ResetGuiMessage": {
        resetGui();
        return;
      }
      // Update props of a GUI component
      case "GuiUpdateMessage": {
        updateGuiProps(message.uuid, message.updates);
        return;
      }
      // Remove a GUI input.
      case "GuiRemoveMessage": {
        removeGui(message.uuid);
        return;
      }

      case "FileTransferStart":
      case "FileTransferPart": {
        fileDownloadHandler(message);
        return;
      }
      case "FileTransferPartAck": {
        updateUploadState({
          componentId: message.source_component_uuid!,
          uploadedBytes: message.transferred_bytes,
          totalBytes: message.total_bytes,
        });
        return;
      }
      default: {
        console.log("Received message did not match any known types:", message);
        return;
      }
    }
  };
}

function useFileDownloadHandler() {
  const downloadStatesRef = React.useRef<{
    [uuid: string]: {
      metadata: FileTransferStart;
      notificationId: string;
      parts: Uint8Array[];
      bytesDownloaded: number;
      displayFilesize: string;
    };
  }>({});

  return (message: FileTransferStart | FileTransferPart) => {
    const notificationId = "download-" + message.transfer_uuid;

    // Create or update download state.
    switch (message.type) {
      case "FileTransferStart": {
        let displaySize = message.size_bytes;
        const displayUnits = ["B", "K", "M", "G", "T", "P"];
        let displayUnitIndex = 0;
        while (
          displaySize >= 100 &&
          displayUnitIndex < displayUnits.length - 1
        ) {
          displaySize /= 1024;
          displayUnitIndex += 1;
        }
        downloadStatesRef.current[message.transfer_uuid] = {
          metadata: message,
          notificationId: notificationId,
          parts: [],
          bytesDownloaded: 0,
          displayFilesize: `${displaySize.toFixed(1)}${
            displayUnits[displayUnitIndex]
          }`,
        };
        break;
      }
      case "FileTransferPart": {
        const downloadState = downloadStatesRef.current[message.transfer_uuid];
        if (message.part != downloadState.parts.length) {
          console.error(
            "A file download message was dropped; this should never happen!",
          );
        }
        downloadState.parts.push(message.content);
        downloadState.bytesDownloaded += message.content.length;
        break;
      }
    }

    // Show notification.
    const downloadState = downloadStatesRef.current[message.transfer_uuid];
    const progressValue =
      (100.0 * downloadState.bytesDownloaded) /
      downloadState.metadata.size_bytes;
    const isDone =
      downloadState.bytesDownloaded == downloadState.metadata.size_bytes;

    (downloadState.bytesDownloaded == 0
      ? notifications.show
      : notifications.update)({
      title:
        (isDone ? "Downloaded " : "Downloading ") +
        `${downloadState.metadata.filename} (${downloadState.displayFilesize})`,
      message: <Progress size="sm" value={progressValue} />,
      id: notificationId,
      autoClose: isDone,
      withCloseButton: isDone,
      loading: !isDone,
      icon: isDone ? <IconCheck /> : undefined,
    });

    // If done: download file and clear state.
    if (isDone) {
      const link = document.createElement("a");
      link.href = window.URL.createObjectURL(
        new Blob(downloadState.parts, {
          type: downloadState.metadata.mime_type,
        }),
      );
      link.download = downloadState.metadata.filename;
      link.click();
      link.remove();
      delete downloadStatesRef.current[message.transfer_uuid];
    }
  };
}

export function FrameSynchronizedMessageHandler() {
  const handleMessage = useMessageHandler();
  const viewer = useContext(ViewerContext)!;
  const messageQueueRef = viewer.messageQueueRef;

  useFrame(
    () => {
      // Send a render along if it was requested!
      if (viewer.getRenderRequestState.current === "triggered") {
        viewer.getRenderRequestState.current = "pause";
      } else if (viewer.getRenderRequestState.current === "pause") {
        const cameraPosition = viewer.getRenderRequest.current!.position;
        const cameraWxyz = viewer.getRenderRequest.current!.wxyz;
        const cameraFov = viewer.getRenderRequest.current!.fov;

        const targetWidth = viewer.getRenderRequest.current!.width;
        const targetHeight = viewer.getRenderRequest.current!.height;

        // Render the scene using the virtual camera
        const T_threeworld_world = computeT_threeworld_world(viewer);
        const transformedPosition = new THREE.Vector3(
          ...cameraPosition,
        ).applyMatrix4(T_threeworld_world);
        const transformedQuaternion = new THREE.Quaternion(
          cameraWxyz[1],
          cameraWxyz[2],
          cameraWxyz[3],
          cameraWxyz[0],
        )
          .premultiply(
            new THREE.Quaternion().setFromRotationMatrix(T_threeworld_world),
          )
          .multiply(
            new THREE.Quaternion().setFromAxisAngle(
              new THREE.Vector3(1, 0, 0),
              Math.PI,
            ),
          );

        const imageDataUrl = renderVirtualCamera(
          viewer.sceneRef.current!,
          targetWidth,
          targetHeight,
          cameraFov,
          transformedPosition.toArray(),
          transformedQuaternion,
        );
        console.log("Rendered image", imageDataUrl);

        // Create an image from the rendered data URL
        const img = new Image();
        img.src = imageDataUrl;

        // We'll save the render to an intermediate canvas with the requested dimensions.
        const renderBufferCanvas = new OffscreenCanvas(
          targetWidth,
          targetHeight,
        );
        const ctx = renderBufferCanvas.getContext("2d")!;
        ctx.reset();

        // Use a white background for JPEGs, which don't have an alpha channel.
        if (viewer.getRenderRequest.current?.format === "image/jpeg") {
          ctx.fillStyle = "white";
          ctx.fillRect(
            0,
            0,
            renderBufferCanvas.width,
            renderBufferCanvas.height,
          );
        }

        // Draw the rendered image onto the canvas
        img.onload = () => {
          ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

          // Encode the image, the send it.
          renderBufferCanvas
            .convertToBlob({
              type: viewer.getRenderRequest.current!.format,
              quality: viewer.getRenderRequest.current!.quality / 100.0,
            })
            .then(async (blob) => {
              if (blob === null) {
                console.error("Render failed");
                viewer.getRenderRequestState.current = "ready";
                return;
              }
              const payload = new Uint8Array(await blob.arrayBuffer());
              viewer.sendMessageRef.current({
                type: "GetRenderResponseMessage",
                payload: payload,
              });
              viewer.getRenderRequestState.current = "ready";
            });
        };
        viewer.getRenderRequestState.current = "in_progress";
      }

      // Handle messages, but only if we're not trying to render something.
      if (viewer.getRenderRequestState.current === "ready") {
        // Handle messages before every frame.
        // Place this directly in ws.onmessage can cause race conditions!
        //
        // If a render is requested, note that we don't handle any more messages
        // until the render is done.
        const requestRenderIndex = messageQueueRef.current.findIndex(
          (message) => message.type === "GetRenderRequestMessage",
        );
        const numMessages =
          requestRenderIndex !== -1
            ? requestRenderIndex + 1
            : messageQueueRef.current.length;
        const processBatch = messageQueueRef.current.splice(0, numMessages);
        processBatch.forEach(handleMessage);
      }
    },
    // We should handle messages before doing anything else!!
    //
    // Importantly, this priority should be *lower* than the useFrame priority
    // used to update scene node transforms in SceneTree.tsx.
    -100000,
  );

  return null;
}

function renderVirtualCamera(
  scene: THREE.Scene,
  width: number,
  height: number,
  fov: number,
  position: [number, number, number],
  quaternion: THREE.Quaternion,
): string {
  // Create a new perspective camera
  const camera = new THREE.PerspectiveCamera(
    THREE.MathUtils.radToDeg(fov),
    width / height,
    0.01,
    1000,
  );

  // Set camera position
  camera.position.set(...position);

  // Set camera rotation using quaternion
  camera.setRotationFromQuaternion(quaternion);

  // Note: We don't need to add the camera to the scene for rendering
  // The renderer.render() function uses the camera directly
  // Create a new renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(width, height);
  renderer.setClearColor(0xffffff, 0); // Set clear color to transparent

  // Render the scene
  renderer.render(scene, camera);

  // Get the rendered image as a data URL
  const imageDataUrl = renderer.domElement.toDataURL("image/png");

  // Clean up
  renderer.dispose();

  return imageDataUrl;
}
