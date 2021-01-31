
import { GfxDevice, GfxFormat, GfxRenderPass, GfxSamplerBinding, GfxPrimitiveTopology, GfxTexFilterMode, GfxMipFilterMode, GfxWrapMode } from "../gfx/platform/GfxPlatform";
import { GfxReadback, GfxAttachment, GfxBindings, GfxRenderPipeline, GfxProgram, GfxSampler, GfxTexture } from "../gfx/platform/GfxPlatformImpl";
import { ColorTexture, makeEmptyRenderPassDescriptor } from "../gfx/helpers/RenderTargetHelpers";
import { preprocessProgram_GLSL } from "../gfx/shaderc/GfxShaderCompiler";
import { fullscreenMegaState } from "../gfx/helpers/GfxMegaStateDescriptorHelpers";
import { assert, assertExists } from "../util";
import { GfxrAttachmentSlot, GfxrGraphBuilder, GfxrRenderTargetDescription } from "../gfx/render/GfxRenderGraph";
import { GfxRenderInstManager } from "../gfx/render/GfxRenderer";

class ColorTextureAttachment {
    public colorTexture: ColorTexture;
    public gfxAttachment: GfxAttachment | null = null;

    constructor(format: GfxFormat = GfxFormat.U8_RGBA_NORM) {
        this.colorTexture = new ColorTexture(format);
    }

    public setParameters(device: GfxDevice, width: number, height: number): boolean {
        if (this.colorTexture.setParameters(device, width, height)) {
            this.destroyAttachment(device);
            this.gfxAttachment = device.createAttachmentFromTexture(this.colorTexture.gfxTexture!);
            return true;
        } else {
            return false;
        }
    }

    private destroyAttachment(device: GfxDevice): void {
        if (this.gfxAttachment !== null) {
            device.destroyAttachment(this.gfxAttachment);
            this.gfxAttachment = null;
        }
    }

    public destroy(device: GfxDevice): void {
        this.colorTexture.destroy(device);
        this.destroyAttachment(device);
    }
}

export class PeekZResult {
    public normalizedX: number;
    public normalizedY: number;
    public attachmentX: number;
    public attachmentY: number;
    public triviallyCulled: boolean = false;
    public value: number | null = null;
}

class PeekZFrame {
    public entries: PeekZResult[] = [];
    public readback: GfxReadback;

    constructor(device: GfxDevice, maxCount: number) {
        const byteCount = maxCount * 0x04;
        this.readback = device.createReadback(byteCount);
    }

    public destroy(device: GfxDevice): void {
        device.destroyReadback(this.readback);
    }
}

export class PeekZManager {
    private framePool: PeekZFrame[] = [];

    private submittedFrames: PeekZFrame[] = [];
    private maxSubmittedFrames: number = 10;
    private currentFrame: PeekZFrame | null = null;
    private resultBuffer: Uint32Array;

    private resolveRenderPassDescriptor = makeEmptyRenderPassDescriptor();
    private colorAttachment = new ColorTextureAttachment(GfxFormat.U32_R);
    private depthTexture = new ColorTexture(GfxFormat.D32F_S8);
    private depthSampler: GfxSampler | null = null;
    private fullscreenCopyPipeline: GfxRenderPipeline | null = null;
    private fullscreenCopyProgram: GfxProgram | null = null;

    constructor(public maxCount: number = 50) {
        this.resultBuffer = new Uint32Array(this.maxCount);

        this.resolveRenderPassDescriptor.depthClearValue = 'load';
        this.resolveRenderPassDescriptor.stencilClearValue = 'load';
    }

    private returnFrame(frame: PeekZFrame): void {
        frame.entries.length = 0;
        this.framePool.push(frame);
    }

    public newData(dst: PeekZResult, x: number, y: number): boolean {
        const frame = assertExists(this.currentFrame);

        // Check for trivial result.
        if (x < -1 || x > 1 || y < -1 || y > 1) {
            dst.triviallyCulled = true;
            return true;
        }

        dst.triviallyCulled = false;

        if (frame.entries.length >= this.maxCount)
            return false;

        dst.normalizedX = x;
        dst.normalizedY = y;
        frame.entries.push(dst);
        return true;
    }

    private ensureCurrentFrame(device: GfxDevice): void {
        assert(this.currentFrame === null);

        if (this.framePool.length > 0)
            this.currentFrame = this.framePool.pop()!;
        else
            this.currentFrame = new PeekZFrame(device, this.maxCount);
    }

    public beginFrame(device: GfxDevice): void {
        this.ensureCurrentFrame(device);
    }

    private ensureResources(device: GfxDevice): void {
        // Kick off pipeline compilation ASAP.
        if (this.fullscreenCopyPipeline === null) {
            const fullscreenVS: string = `
out vec2 v_TexCoord;

void main() {
    v_TexCoord.x = (gl_VertexID == 1) ? 2.0 : 0.0;
    v_TexCoord.y = (gl_VertexID == 2) ? 2.0 : 0.0;
    gl_Position.xy = v_TexCoord * vec2(2) - vec2(1);
    gl_Position.zw = vec2(1, 1);
}
`;
            const fullscreenFS: string = `
uniform sampler2D u_Texture;
in vec2 v_TexCoord;

out uint o_Output;

void main() {
    vec4 color = texture(SAMPLER_2D(u_Texture), v_TexCoord);
    o_Output = uint(color.r * 4294967295.0);
}
`;
            const fullscreenProgramDescriptor = preprocessProgram_GLSL(device.queryVendorInfo(), fullscreenVS, fullscreenFS);
            this.fullscreenCopyProgram = device.createProgramSimple(fullscreenProgramDescriptor);
            this.fullscreenCopyPipeline = device.createRenderPipeline({
                bindingLayouts: [{ numSamplers: 1, numUniformBuffers: 0 }],
                inputLayout: null,
                megaStateDescriptor: fullscreenMegaState,
                program: this.fullscreenCopyProgram,
                sampleCount: 1,
                topology: GfxPrimitiveTopology.TRIANGLES,
            });
        }

        if (this.depthSampler === null) {
            // According to the GLES spec, depth textures *must* be filtered as NEAREST.
            // https://github.com/google/angle/blob/49a53d684affafc0bbaa2d4c2414113fe95329ce/src/libANGLE/Texture.cpp#L362-L383
            this.depthSampler = device.createSampler({
                minFilter: GfxTexFilterMode.POINT,
                magFilter: GfxTexFilterMode.POINT,
                mipFilter: GfxMipFilterMode.NO_MIP,
                wrapS: GfxWrapMode.CLAMP,
                wrapT: GfxWrapMode.CLAMP,
                minLOD: 0,
                maxLOD: 100,
            });
        }
    }

    private stealCurrentFrameAndCheck(device: GfxDevice): PeekZFrame | null {
        const frame = this.currentFrame;
        this.currentFrame = null;

        if (frame === null)
            return null;

        this.ensureResources(device);

        if (!device.queryPipelineReady(this.fullscreenCopyPipeline!)) {
            // Pipeline not ready yet.
            this.returnFrame(frame);
            return null;
        }

        if (this.submittedFrames.length >= this.maxSubmittedFrames) {
            // Too many frames in flight, discard this one.
            this.returnFrame(frame);
            return null;
        }

        if (frame.entries.length === 0) {
            // No need to copy if we aren't trying to read.
            this.returnFrame(frame);
            return null;
        }

        return frame;
    }

    private submitFramePost(device: GfxDevice, frame: PeekZFrame, depthColorTexture: GfxTexture, width: number, height: number): void {
        // Now go through and start submitting readbacks on our texture.
        for (let i = 0; i < frame.entries.length; i++) {
            const entry = frame.entries[i];

            // User specifies coordinates in -1 to 1 normalized space. Convert to attachment space.
            entry.attachmentX = (((entry.normalizedX * 0.5) + 0.5) * width + 0.5) | 0;
            entry.attachmentY = (((entry.normalizedY * 0.5) + 0.5) * height + 0.5) | 0;

            device.readPixelFromTexture(frame.readback, i, depthColorTexture, entry.attachmentX, entry.attachmentY);
        }

        device.submitReadback(frame.readback);
        this.submittedFrames.push(frame);
    }

    public pushPasses(device: GfxDevice, renderInstManager: GfxRenderInstManager, builder: GfxrGraphBuilder, width: number, height: number, depthTargetID: number): void {
        const frame = this.stealCurrentFrameAndCheck(device);
        if (frame === null)
            return;

        const colorTargetDesc = new GfxrRenderTargetDescription(GfxFormat.U32_R);
        colorTargetDesc.setParameters(width, height, 1);
        const colorTargetID = builder.createRenderTargetID(colorTargetDesc, 'PeekZ Color Buffer');

        builder.pushPass((pass) => {
            pass.setDebugName('PeekZ');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, colorTargetID);
            const resolvedDepthTextureID = builder.resolveRenderTarget(depthTargetID);
            pass.attachResolveTexture(resolvedDepthTextureID);
            pass.exec((passRenderer, scope) => {
                const resolvedDepthTexture = scope.getResolveTextureForID(resolvedDepthTextureID);

                const renderInst = renderInstManager.newRenderInst();
                renderInst.setGfxRenderPipeline(this.fullscreenCopyPipeline!);
                renderInst.setBindingLayouts([{ numSamplers: 1, numUniformBuffers: 0 }]);
                renderInst.drawPrimitives(3);

                const samplerBindings: GfxSamplerBinding[] = [{ gfxTexture: resolvedDepthTexture, gfxSampler: this.depthSampler, lateBinding: null }];
                renderInst.setSamplerBindingsFromTextureMappings(samplerBindings);

                renderInst.drawOnPass(device, renderInstManager.gfxRenderCache, passRenderer);
            });

            pass.post((scope) => {
                const colorTexture = assertExists(scope.getRenderTargetTexture(GfxrAttachmentSlot.Color0));
                this.submitFramePost(device, frame, colorTexture, width, height);
            });
        });
    }

    public peekData(device: GfxDevice): void {
        // Resolve the first frame we can.

        for (let i = 0; i < this.submittedFrames.length; i++) {
            const frame = this.submittedFrames[i];
            if (device.queryReadbackFinished(this.resultBuffer, 0, frame.readback)) {
                this.submittedFrames.splice(i, 1);
                // Copy results to clients.
                for (let j = 0; j < frame.entries.length; j++)
                    frame.entries[j].value = this.resultBuffer[j] / 0xFFFFFFFF;
                this.returnFrame(frame);
                break;
            }
        }
    }

    public destroy(device: GfxDevice): void {
        if (this.currentFrame !== null)
            this.currentFrame.destroy(device);
        for (let i = 0; i < this.submittedFrames.length; i++)
            this.submittedFrames[i].destroy(device);
        for (let i = 0; i < this.framePool.length; i++)
            this.framePool[i].destroy(device);
        if (this.fullscreenCopyProgram !== null)
            device.destroyProgram(this.fullscreenCopyProgram);
        if (this.fullscreenCopyPipeline !== null)
            device.destroyRenderPipeline(this.fullscreenCopyPipeline);
        if (this.depthSampler !== null)
            device.destroySampler(this.depthSampler);
        this.depthTexture.destroy(device);
        this.colorAttachment.destroy(device);
    }
}
