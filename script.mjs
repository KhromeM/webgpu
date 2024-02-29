const canvas = document.querySelector("canvas");
const GRID_SIZE = 1000;
const UPDATE_INTERVAL = 4;
const WORKGROUP_SIZE = 8;
let step = 0;

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

const vertices = new Float32Array([
	// use indexBuffers to avoid repeating vertices
	-0.8, -0.8, 0.8, -0.8, 0.8, 0.8, -0.8, -0.8, 0.8, 0.8, -0.8, 0.8,
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

// uniform buffer that describes the grid
const uniformArray = new Float32Array([GRID_SIZE, GRID_SIZE]);
const uniformBuffer = device.createBuffer({
	label: "grid uniforms",
	size: uniformArray.byteLength,
	usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});
device.queue.writeBuffer(uniformBuffer, 0, uniformArray);
// uniform buffers have to be static in size (because we need to write it's length in the shaders)
// unifrom buffers also can't be written to by compute shaders
// why use uniform buffers? They are optimized. Use for frequently changing fixed size data

// storage buffer
const cellStateArray = new Uint32Array(GRID_SIZE * GRID_SIZE);
for (let i = 0; i < cellStateArray.length; i++) {
	cellStateArray[i] = Math.random() > 0.7 ? 1 : 0;
}
const cellStateStorage = [
	device.createBuffer({
		label: "cell state A",
		size: cellStateArray.byteLength,
		usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
	}),
	device.createBuffer({
		label: "cell state B",
		size: cellStateArray.byteLength,
		usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
	}),
];
device.queue.writeBuffer(cellStateStorage[0], 0, cellStateArray);
device.queue.writeBuffer(cellStateStorage[1], 0, cellStateArray);

// vertex shader is called once for every vertex in the vertexBuffer
// vertex shader processes the vertex and returns a position in clip space
// runs in parallel. the position of one vertex is not dependent on others
const cellShaderModule = device.createShaderModule({
	label: "cell shader",
	code: `
        // shader code goes here:
        
        struct VertexInput {
            @location(0) pos: vec2f,
            @builtin(instance_index) instance: u32,
        };

        struct VertexOutput {
            @builtin(position) pos: vec4f,
            @location(0) cell: vec2f,
        };

        @group(0) @binding(0) var<uniform> grid: vec2f;
		@group(0) @binding(1) var<storage> cellState: array<u32>;

        @vertex
        fn vertexMain(input: VertexInput) -> VertexOutput {
			let state = f32(cellState[input.instance]);
            let i = f32(input.instance);
            var gridPos: vec2f = (input.pos + .8) / grid; // places in lower left
            gridPos *= 1.25;
            gridPos -= 1;
            let cell: vec2f = vec2f(floor(i / grid.x), i % grid.x);
            gridPos += cell / (grid / 2);
			gridPos *= state;
			
            var output: VertexOutput;
            output.pos = vec4f(gridPos, 0, 1);
            output.cell = cell;
            return output;
        }

        @fragment
        fn fragmentMain(@location(0) cell: vec2f) -> @location(0) vec4f {
            let rg: vec2f = cell/grid;
            return vec4f(rg,(1 - rg.x * rg.y),1);
        }
    `,
});

const simShaderModule = device.createShaderModule({
	label: "Game of life compute shader",
	code: `
	@group(0) @binding(0) var<uniform> grid: vec2f;
	@group(0) @binding(1) var<storage> cellStateIn: array<u32>;
	@group(0) @binding(2) var<storage, read_write> cellStateOut: array<u32>;

	fn getIndex(x :u32, y :u32) -> u32 {
		return x % u32(grid.x) * u32(grid.x) + y % u32(grid.y);
	}

	fn neighborsActive(cell: vec2u) -> u32 {
		var count :u32 = 0;
		count += cellStateIn[getIndex(cell.x+1, cell.y+1)];
        count += cellStateIn[getIndex(cell.x+1, cell.y)];
		count += cellStateIn[getIndex(cell.x+1, cell.y-1)];

		count += cellStateIn[getIndex(cell.x, cell.y+1)];
		count += cellStateIn[getIndex(cell.x, cell.y-1)];

		count += cellStateIn[getIndex(cell.x-1, cell.y+1)];
        count += cellStateIn[getIndex(cell.x-1, cell.y)];
		count += cellStateIn[getIndex(cell.x-1, cell.y-1)];

		return count;

	}

	@compute
	@workgroup_size(${WORKGROUP_SIZE},${WORKGROUP_SIZE})
	fn computeMain(@builtin(global_invocation_id) cell: vec3u){
		let index :u32 = getIndex(cell.x, cell.y);
		let count :u32 = neighborsActive(cell.xy);
		
		if (index >= u32(grid.x * grid.y)){ // return early if out of bounds
			return;
		}

		if (count < 2){
			cellStateOut[index] = 0;
		} else if (count == 2){
			cellStateOut[index] = cellStateIn[index];
		}else if (count == 3){
			cellStateOut[index] = 1;
		} else if (count > 3){
			cellStateOut[index] = 0;
		}
	}
	`,
});

// the fragment shader is invoked once for every pixel that is drawn
// the GPU triangulates the output of the vertex shaders using 3 points
// then it rasterizes each triangle by figuring out which pixels of the output color attachments are included in the triangle
// the fragment shader then runs on each of those pixels and usually returns a color vector

// create a bind group layout
const bindGroupLayout = device.createBindGroupLayout({
	label: "cell bind group layout",
	entries: [
		{
			binding: 0,
			visibility:
				GPUShaderStage.VERTEX |
				GPUShaderStage.COMPUTE |
				GPUShaderStage.FRAGMENT,
			buffer: {}, // vector with grid dimensions
		},
		{
			binding: 1,
			visibility: GPUShaderStage.VERTEX | GPUShaderStage.COMPUTE,
			buffer: { type: "read-only-storage" }, // cellStateInput storage buffer
		},
		{
			binding: 2,
			visibility: GPUShaderStage.COMPUTE,
			buffer: { type: "storage" }, // cell state output storage buffer
		},
	],
});

const pieplineLayout = device.createPipelineLayout({
	label: "cell pipeline layout",
	bindGroupLayouts: [bindGroupLayout],
});

// Render Pipeline:
const cellPipeline = device.createRenderPipeline({
	label: "Cell Pipeline",
	layout: pieplineLayout,
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

const simPipeline = device.createComputePipeline({
	label: "Sim compute pipeline",
	layout: pieplineLayout,
	compute: {
		module: simShaderModule,
		entryPoint: "computeMain",
	},
});

// create a bind group
const bindGroups = [
	device.createBindGroup({
		label: "cell renderer bind group A",
		layout: bindGroupLayout,
		entries: [
			{
				binding: 0,
				resource: {
					buffer: uniformBuffer,
				},
			},
			{
				binding: 1,
				resource: {
					buffer: cellStateStorage[0],
				},
			},
			{
				binding: 2,
				resource: {
					buffer: cellStateStorage[1],
				},
			},
		],
	}),
	device.createBindGroup({
		label: "cell renderer bind group B",
		layout: bindGroupLayout,
		entries: [
			{
				binding: 0,
				resource: {
					buffer: uniformBuffer,
				},
			},
			{
				binding: 1,
				resource: {
					buffer: cellStateStorage[1],
				},
			},
			{
				binding: 2,
				resource: {
					buffer: cellStateStorage[0],
				},
			},
		],
	}),
];

function updateGrid() {
	if (step % 1000 == 0) {
		let s = Date.now();
		console.log(`1000 frames rendered in ${(s - t) / 1000} seconds`);
		t = s;
	}
	const encoder = device.createCommandEncoder();

	const computePass = encoder.beginComputePass();
	computePass.setPipeline(simPipeline);
	computePass.setBindGroup(0, bindGroups[step % 2]);
	const workgroupCount = Math.ceil(GRID_SIZE / WORKGROUP_SIZE);
	computePass.dispatchWorkgroups(workgroupCount, workgroupCount);
	computePass.end();
	step++;

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
	pass.setBindGroup(0, bindGroups[step % 2]);
	pass.draw(vertices.length / 2, GRID_SIZE * GRID_SIZE);
	pass.end();

	const commandBuffer = encoder.finish();
	device.queue.submit([commandBuffer]);
	// once a commandBuffer is submitted it cant be used again. Create a new one for next time.
}
let t = Date.now();
setInterval(updateGrid, UPDATE_INTERVAL);
