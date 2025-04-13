(function () {
  // Global variables and uniform locations.
  let editor, gl, shaderProgram, vertexBuffer, startTime;
  let canvas, errorDisplay;
  let mousePos = { x: 0, y: 0 };
  let lastKey = 0;
  let u_timeLoc, u_resolutionLoc, u_mouseLoc, u_videoLoc, u_keyLoc;
  let video, videoTexture, videoReady = false;
  let videoStream = null;  // Store active camera stream.
  let cameraFacing = null; // "user" or "environment"
  
  // Offscreen canvas to flip the video for front camera.
  const flipCanvas = document.createElement('canvas');
  const flipCtx = flipCanvas.getContext('2d');

  // Updated default fragment shader without the mouse circle effect.
  const defaultFragmentShader = `
precision mediump float;
uniform float u_time;
uniform vec2 u_resolution;
uniform vec2 u_mouse;
uniform sampler2D u_video;
uniform int u_key;

void main(void) {
  // Compute normalized pixel coordinates.
  vec2 st = gl_FragCoord.xy / u_resolution;
  vec3 color = vec3(st.x, st.y, abs(sin(u_time)));
  
  // Sample the video texture if available.
  vec4 videoColor = texture2D(u_video, st);
  
  // Mix shader color with video texture based on key pressed.
  if(u_key != 0){
    color = mix(color, videoColor.rgb, 0.5);
  }
  
  gl_FragColor = vec4(color, 1.0);
}`;
  
  const vertexShaderSource = `
attribute vec2 a_position;
void main(void) {
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

  // Initialize WebGL and set up event listeners.
  function initWebGL() {
    canvas = document.getElementById("gl-canvas");
    errorDisplay = document.getElementById("error-display");
    gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) {
      showError("WebGL is not supported in this browser.");
      return;
    }
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
    canvas.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("keydown", handleKeyDown);

    setupBuffers();
    compileAndUseProgram(defaultFragmentShader);
    initVideoTexture();
    startTime = performance.now();
    requestAnimationFrame(renderLoop);
    setupCameraButtons();
  }

  // Resize the canvas.
  function resizeCanvas() {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    if (gl) {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    }
  }

  // Create a vertex buffer for a full-screen quad.
  function setupBuffers() {
    const vertices = new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
       1,  1
    ]);
    vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  }

  // Compile a shader and check for errors.
  function compileShader(source, type) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error("Shader compilation error: " + log);
    }
    return shader;
  }

  // Compile the shaders and create the shader program.
  function compileAndUseProgram(fragmentSource) {
    if (shaderProgram) {
      gl.deleteProgram(shaderProgram);
    }
    try {
      const vertexShader = compileShader(vertexShaderSource, gl.VERTEX_SHADER);
      const fragmentShader = compileShader(fragmentSource, gl.FRAGMENT_SHADER);
      shaderProgram = gl.createProgram();
      gl.attachShader(shaderProgram, vertexShader);
      gl.attachShader(shaderProgram, fragmentShader);
      gl.linkProgram(shaderProgram);
      if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(shaderProgram);
        throw new Error("Program linking error: " + log);
      }
      gl.useProgram(shaderProgram);

      // Set up the vertex attribute.
      const posAttrib = gl.getAttribLocation(shaderProgram, "a_position");
      gl.enableVertexAttribArray(posAttrib);
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
      gl.vertexAttribPointer(posAttrib, 2, gl.FLOAT, false, 0, 0);

      // Get uniform locations.
      u_timeLoc = gl.getUniformLocation(shaderProgram, "u_time");
      u_resolutionLoc = gl.getUniformLocation(shaderProgram, "u_resolution");
      u_mouseLoc = gl.getUniformLocation(shaderProgram, "u_mouse");
      u_videoLoc = gl.getUniformLocation(shaderProgram, "u_video");
      u_keyLoc = gl.getUniformLocation(shaderProgram, "u_key");

      hideError();
    } catch (e) {
      showError(e.message);
    }
  }

  // Render loop that updates uniforms and draws.
  function renderLoop() {
    const currentTime = performance.now();
    const elapsedTime = (currentTime - startTime) / 1000.0;
    if (shaderProgram) {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      if (u_timeLoc) gl.uniform1f(u_timeLoc, elapsedTime);
      if (u_resolutionLoc) gl.uniform2f(u_resolutionLoc, canvas.width, canvas.height);
      if (u_mouseLoc) gl.uniform2f(u_mouseLoc, mousePos.x, canvas.height - mousePos.y);
      if (u_keyLoc) gl.uniform1i(u_keyLoc, lastKey);

      // Update video texture.
      if (videoReady && videoTexture) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, videoTexture);
        // If front camera ("user"), flip vertically.
        if (cameraFacing === "user") {
          flipCanvas.width = video.videoWidth;
          flipCanvas.height = video.videoHeight;
          flipCtx.save();
          flipCtx.scale(1, -1);
          flipCtx.drawImage(video, 0, -video.videoHeight, video.videoWidth, video.videoHeight);
          flipCtx.restore();
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, flipCanvas);
        } else {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
        }
        gl.uniform1i(u_videoLoc, 0);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    requestAnimationFrame(renderLoop);
  }

  // Debounce shader updates from the Monaco editor.
  let debounceTimer;
  function onEditorChange() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const code = editor.getValue() || defaultFragmentShader;
      compileAndUseProgram(code);
    }, 500);
  }

  // Display shader errors.
  function showError(message) {
    errorDisplay.style.display = "block";
    errorDisplay.textContent = message;
    highlightErrorInEditor(message);
  }

  // Hide the error display.
  function hideError() {
    errorDisplay.style.display = "none";
    errorDisplay.textContent = "";
    removeErrorDecorations();
  }

  // Highlight erroneous lines in the Monaco Editor.
  let errorDecorations = [];
  function highlightErrorInEditor(message) {
    removeErrorDecorations();
    if (message) {
      const errorLines = extractErrorLines(message);
      errorDecorations = editor.deltaDecorations(errorDecorations, errorLines.map(line => ({
        range: new monaco.Range(line, 1, line, 1),
        options: { inlineClassName: 'monaco-error-highlight' }
      })));
    }
  }

  // Remove error highlighting.
  function removeErrorDecorations() {
    if (errorDecorations.length > 0) {
      editor.deltaDecorations(errorDecorations, []);
      errorDecorations = [];
    }
  }

  // Extract error line numbers using a refined regex for GLSL errors.
  function extractErrorLines(message) {
    const errorLines = [];
    // The regex looks for common formats like: "ERROR: 0:5:" where 5 is the line number.
    const regex = /ERROR:\s*0:(\d+):/g;
    let match;
    while ((match = regex.exec(message)) !== null) {
      errorLines.push(parseInt(match[1], 10));
    }
    return errorLines;
  }

  // --- Mouse Interaction ---
  function handleMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    mousePos.x = e.clientX - rect.left;
    mousePos.y = e.clientY - rect.top;
  }

  // --- Keyboard Interaction ---
  function handleKeyDown(e) {
    lastKey = e.keyCode;
  }

  // --- Camera / Video Texture Setup ---
  function initVideoTexture() {
    // Create a video element used for the camera feed.
    video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    // Create a texture for the video.
    videoTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, videoTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    // Initialize with a 1x1 pixel.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0]));
  }

  // Start the camera using the specified facing mode.
  function startCamera(facingMode) {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ video: { facingMode } })
        .then(stream => {
          videoStream = stream;
          cameraFacing = facingMode;
          video.srcObject = stream;
          video.play();
          video.onloadeddata = () => {
            videoReady = true;
          };
        })
        .catch(err => {
          showError("Camera error: " + err.message);
        });
    } else {
      showError("getUserMedia not supported in this browser.");
    }
  }

  // Stop the active camera stream.
  function stopCamera() {
    if (videoStream) {
      videoStream.getTracks().forEach(track => track.stop());
      videoStream = null;
    }
    videoReady = false;
    cameraFacing = null;
    if (video) {
      video.srcObject = null;
    }
  }

  // Set up event listeners for camera control buttons.
  function setupCameraButtons() {
    document.getElementById("front-camera").addEventListener("click", () => {
      startCamera("user");
    });
    document.getElementById("back-camera").addEventListener("click", () => {
      startCamera("environment");
    });
    document.getElementById("stop-camera").addEventListener("click", () => {
      stopCamera();
    });
  }

  // Configure and initialize the Monaco Editor.
  require.config({ paths: { vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.35.0/min/vs" } });
  require(["vs/editor/editor.main"], function () {
    editor = monaco.editor.create(document.getElementById("editor-container"), {
      value: defaultFragmentShader,
      language: "glsl",
      theme: "vs-dark",
      automaticLayout: true
    });
    editor.getModel().onDidChangeContent(onEditorChange);
  });

  // Initialize WebGL when the window loads.
  window.addEventListener("load", initWebGL);
})();
