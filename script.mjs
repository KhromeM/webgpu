const canvas = document.querySelector("canvas");
const GRID_SIZE = 5000;

if (!navigator.gpu) {
	// browser doenst support webgpu
	alert("WebGPU is not supported on this browser.");
	throw new Error("WebGPU is not supported on this browser.");
}

const adapter = await navigator.gpu.requestAdapter(); // can pass arugments to get a high/low power gpu
if (!adapter) {
	// hardware doesnt support webgpu
	throw new Error("No GPUAdapter found.");
}
const device = await adapter.requestDevice(); // can pass arguments
const context = canvas.getContext("webgpu");
const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
context.configure({
	device: device,
	format: canvasFormat, // texture format the canvas will use
});
// textures are objects that webgpu useds to store image data, texture formats will the gpu how the data is layed out
// can have multiple canvases rended by one device

const encoder = device.createCommandEncoder();

const vertices = new Float32Array([
	// use indexBuffers to avoid repeating vertices
	//   X,    Y,
	-0.8,
	-0.8, // Triangle 1 (Blue)
	0.8,
	-0.8,
	0.8,
	0.8,
	-0.8,
	-0.8, // Triangle 2 (Red)
	0.8,
	0.8,
	-0.8,
	0.8,
]);

// need to send this data to be stored on the GPU

const vertexBuffer = device.createBuffer({
	// cant resize or change usageflags after creation
	label: "cell vertices", // optional but helps in debugging
	size: vertices.byteLength,
	usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
});

device.queue.writeBuffer(vertexBuffer, 0, vertices); // (vertexBuffer, offset, vertexArray)

const vertexBufferLayout = {
	arrayStride: 8, // byte length of each vertex
	attributes: [
		{
			format: "float32x2",
			offset: 0,
			shaderLocation: 0, // between 0-15, i think it the arguments order for the vertex shdader
		},
	],
};

// uniform buffer that describes a grid
const uniformArray = new Float32Array([GRID_SIZE, GRID_SIZE]);
const uniformBuffer = device.createBuffer({
	label: "grid uniforms",
	size: uniformArray.byteLength,
	usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});
device.queue.writeBuffer(uniformBuffer, 0, uniformArray);

// vertex shader is called once for every vertex in the vertexBuffer
// vertex shader processes the vertex and returns a position in clip space
// runs in parallel. the position of one vertex is not dependent on others
const cellShaderModule = device.createShaderModule({
	label: "cell shader",
	code: `
        // shader code goes here:
        @group(0) @binding(0) var<uniform> grid: vec2f;

        @vertex
        fn vertexMain(
            @location(0) pos: vec2f,
            @builtin(instance_index) instance: u32) ->
        @builtin(position) vec4f {
            let i = f32(instance);
            var gridPos: vec2f = (pos + 1) / grid - 1; // places in lower left
            gridPos += vec2f(floor(i / grid.x), i % grid.x) / (grid / 2);
            return vec4f(gridPos, 0,1);
        }

        @fragment
        fn fragmentMain() -> @location(0) vec4f {
            return vec4f(1,1,0,1);
        }
    `,
});

// the fragment shader is invoked once for every pixel that is drawn
// the GPU triangulates the output of the vertex shaders using 3 points
// then it rasterizes each triangle by figuring out which pixels of the output color attachments are included in the triangle
// the fragment shader then runs on each of those pixels and usually returns a color vector

// Render Pipeline:

const cellPipeline = device.createRenderPipeline({
	label: "Cell Pipeline",
	layout: "auto",
	vertex: {
		module: cellShaderModule,
		entryPoint: "vertexMain",
		buffers: [vertexBufferLayout],
	},
	fragment: {
		module: cellShaderModule,
		entryPoint: "fragmentMain",
		targets: [
			{
				format: canvasFormat,
			},
		],
	},
});

// create a bind group
const bindGroup = device.createBindGroup({
	label: "cell renderer bind group",
	layout: cellPipeline.getBindGroupLayout(0),
	entries: [
		{
			binding: 0,
			resource: {
				buffer: uniformBuffer,
			},
		},
	],
});

const pass = encoder.beginRenderPass({
	colorAttachments: [
		{
			view: context.getCurrentTexture().createView(),
			loadOp: "clear",
			clearValue: [0.2, 0, 0.2, 1],
			storeOp: "store",
		},
	],
});

pass.setPipeline(cellPipeline);
pass.setVertexBuffer(0, vertexBuffer);

pass.setBindGroup(0, bindGroup);

pass.draw(vertices.length / 2, GRID_SIZE * GRID_SIZE);

pass.end();

const commandBuffer = encoder.finish();
device.queue.submit([commandBuffer]);
// once a commandBuffer is submitted it cant be used again. Create a new one for next time.
