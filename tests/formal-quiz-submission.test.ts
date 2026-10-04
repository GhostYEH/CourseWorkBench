import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiResponses, type PlanPayloadDto, type QuestionAssessmentDto } from '@sew/study-contracts';
import { closeProject, openProjectFromDisk, type Session } from '../apps/learning/lib/server/service';
import { attachFormalLessonDocument, loadRenderableDocument } from '../apps/learning/lib/server/classroom-service';
import { POST } from '../apps/learning/app/api/maic/runtime/[...segments]/route';
import { buildFormalLessonDocument } from '../apps/learning/lib/classroom/formal-lesson-document';
import { createNodeSqliteDriver, projectPaths } from '@sew/study-storage';
import { classroomDocumentDigest } from '@sew/study-domain';

const assessment = (type: QuestionAssessmentDto['type']): QuestionAssessmentDto => ({
  schemaVersion: 1, type, options: type === 'short_answer' ? [] : [{value:'A',label:'定义'}, {value:'B',label:'反例'}, {value:'C',label:'条件'}],
  correctAnswers: type === 'short_answer' ? [] : type === 'multiple' ? ['A','C'] : ['A'],
  maxScore: 5, rubric: '简答须由教师结合原始过程审核', answerVersion: 1,
});

describe('正式测验不可变提交与原子判分', () => {
  let root: string;
  let session: Session;
  let projectId: string;
  let knowledgeId: string;
  let otherKnowledgeId: string;
  let stageId: string;
  let lessonId: string;
  let questionIds: string[];
  let sceneIds: string[];

  const request = async (segments: string[], body: unknown) => POST(new Request('http://service.local/api/maic/runtime/' + segments.join('/'), {
    method: 'POST', headers: {'x-sew-project-id':session.projectId,'x-sew-generation':String(session.generation)}, body: JSON.stringify(body),
  }), {params:Promise.resolve({segments})});
  const create = async (index: number, id = `runtime-${index}`) => {
    const at = new Date().toISOString();
    const response = await request(['sessions'], {id,kind:'quizAttempt',stageId,learnerKey:'forged',status:'active',createdAt:at,updatedAt:at});
    expect(response.status).toBe(201);
    return id;
  };
  const submission = (index: number, answerText: string, extras = {}) => ({
    scope:{projectId:session.projectId,generation:session.generation}, sessionId:`runtime-${index}`,sceneId:sceneIds[index],questionId:questionIds[index],
    idempotencyKey:`submission-${index}`, answerText,processText:'我的推理过程',expectedLastSeq:null,...extras,
  });
  beforeEach(() => {
    root=mkdtempSync(join(tmpdir(),'sew-formal-quiz-'));
    session=openProjectFromDisk(root); projectId=session.projectId;
    const imported = session.store.importMaterial({
      projectId,
      displayName: '考纲.md',
      materialType: 'md',
      rawText: '本章要求理解增函数的定义。\n\n判断单调性的基本步骤是取值、作差、变形、定号、下结论。',
    });
    const materialId = imported.material.materialId;
    const makeKnowledge = (name: string, concept: string, segmentId: string): string => {
      const proposal = session.store.createProposal({
        projectId,
        name,
        concept,
        conditions: '同一区间内',
        scopeStatus: 'in_syllabus',
        prerequisites: [],
        evidence: [{ materialId, revision: 1, segmentId, use: 'concept_basis' }],
        acceptance: '',
        priority: 'medium',
        proposedBy: 'user',
      });
      return session.store.applyReview({
        proposalId: proposal.proposalId,
        decision: 'approved',
        expectedRevision: proposal.revision,
        semanticReviewed: true,
      }).knowledgePoint!.knowledgeId;
    };
    knowledgeId = makeKnowledge('增函数定义', '区间内任取 x1 < x2 都有 f(x1) < f(x2)', 'S001');
    otherKnowledgeId = makeKnowledge('单调性判断步骤', '取值、作差、变形、定号、下结论', 'S002');
    session.store.savePlanVersion(projectId, 1, 'confirmed', {
      payloadVersion: 1,
      goal: '掌握本章',
      examDate: null,
      dailyMinutes: 60,
      tasks: [
        { knowledgeId, name: '增函数定义', minutes: 30, acceptance: '', evidence: [{ materialId, segmentId: 'S001' }] },
        { knowledgeId: otherKnowledgeId, name: '判断步骤', minutes: 20, acceptance: '', evidence: [{ materialId, segmentId: 'S002' }] },
      ],
      gaps: [],
      basis: '测试计划',
      confirmedTaskKnowledgeIds: [knowledgeId, otherKnowledgeId],
    } satisfies PlanPayloadDto);

    questionIds = (['single','multiple','short_answer'] as const).map((type) => session.store.createQuestion({
      stem:`题目-${type}`,answer:'A',solution:'不可泄露的解析',knowledgeIds:[knowledgeId],requestedOrigin:'ai_new',originRecord:null,assessment:assessment(type),
    }).question.questionId);
    const bundle=session.store.buildLessonBundle(projectId,[{knowledgeId,text:'定义陈述',conditions:''}],questionIds);
    const lesson=session.store.createLessonDraft({projectId,lessonId:null,title:'正式测验课',bundleId:bundle.bundleId,
      statementIds:bundle.bundle.statements.map(item=>item.statementId),questionIds});
    lessonId=lesson.lessonId;
    session.store.reviewLesson({projectId,lessonId,version:lesson.version,decision:'approved',note:'已核题型和评分规则'});
    session.store.publishLesson({projectId,lessonId,version:lesson.version});
    const info=attachFormalLessonDocument(session,lessonId,lesson.version); stageId=info.stageId;
    sceneIds=questionIds.map(id=>info.scenes.find(item=>item.questionId===id)!.sceneId);
  });
  afterEach(()=>{closeProject();rmSync(root,{recursive:true,force:true});});

  it('公开文档隐藏答案解析与评分依据，冻结文档保存完整测验',()=>{
    const renderable=JSON.stringify(loadRenderableDocument(session,stageId)!.document);
    expect(renderable).not.toContain('不可泄露的解析');
    expect(renderable).not.toContain('"answer":');
    expect(renderable).not.toContain('"analysis":');
    expect(renderable).not.toContain('"points":');
    expect(session.store.getClassroomDocument(projectId,stageId)!.sceneCount).toBe(4);
  });

  it.each([{index:0,answer:'A',status:'correct',correct:true,earned:5}, {index:1,answer:'["C","A"]',status:'correct',correct:true,earned:5},
    {index:1,answer:'["A"]',status:'incorrect',correct:false,earned:0}, {index:2,answer:'A',status:'pending_review',correct:null,earned:null}])
  ('按已审核题型判分：$index/$status',async({index,answer,status,correct,earned})=>{
    await create(index);
    const response=await request(['submit'],submission(index,answer)); expect(response.status).toBe(200);
    const envelope=await response.json(); expect(apiResponses.quizSubmit.safeParse(envelope.data).success).toBe(true);
    expect(envelope.data.record.payload.results[0]).toMatchObject({status,correct,earned,maxScore:5,answerVersion:1});
    expect(envelope.data.attempt.questionRevision).toBe(1);
    expect(session.store.runtime.getSession(projectId,`runtime-${index}`)!.status).toBe('completed');
    if(index===2) expect(envelope.data.attempt.masteryAfter).toBeNull();
  });

  it('空白简答不产生不可变提交',async()=>{
    await create(2);
    expect((await request(['submit'],submission(2,'  \n '))).status).toBe(400);
    expect(session.store.listAttempts()).toHaveLength(0);
  });

  it('持久收据重启后读回，跨场景或新内容重试被拒绝',async()=>{
    await create(0);const body=submission(0,'A');
    const first=await(await request(['submit'],body)).json();
    closeProject();session=openProjectFromDisk(root);
    const retry=await(await request(['submit'],{...body,scope:{projectId,generation:session.generation}})).json();
    expect(retry.data.deduplicated).toBe(true);expect(retry.data.record.id).toBe(first.data.record.id);
    expect(session.store.listAttempts()).toHaveLength(1);
    expect((await request(['submit'],{...body,scope:{projectId,generation:session.generation},sceneId:sceneIds[1]})).status).toBe(409);
    expect((await request(['submit'],{...body,scope:{projectId,generation:session.generation},answerText:'B'})).status).toBe(409);
  });

  it('坏尾序号回滚本人作答、掌握、结果与收据',async()=>{
    await create(0);const before=session.store.getKnowledge(knowledgeId)!.masteryStatus;
    expect((await request(['submit'],submission(0,'A',{expectedLastSeq:9}))).status).toBe(409);
    expect(session.store.listAttempts()).toHaveLength(0);expect(session.store.runtime.listRecords(projectId,'runtime-0')).toHaveLength(0);
    expect(session.store.runtime.getQuizReceipt(projectId,'submission-0')).toBeUndefined();
    expect(session.store.runtime.getSession(projectId,'runtime-0')!.status).toBe('active');
    expect(session.store.getKnowledge(knowledgeId)!.masteryStatus).toBe(before);
    expect((await request(['submit'],submission(0,'A'))).status).toBe(200);
  });

  it.each(['withdraw','source'] as const)('新提交在课程/来源失效时阻断：%s',async(mode)=>{
    await create(0);
    if(mode==='withdraw') session.store.withdrawLesson({projectId,lessonId,reason:'撤回'});
    else session.store.importMaterial({projectId,displayName:'考纲.md',materialType:'md',rawText:'新的来源'});
    expect((await request(['submit'],submission(0,'A'))).status).not.toBe(200);expect(session.store.listAttempts()).toHaveLength(0);
  });

  it('只装配课程选中的题目陈述，旧包无快照不补写，上限逐项记录',()=>{
    const lesson=session.store.getLessonVersion(lessonId,1,projectId)!;
    const bundle=session.store.getEvidenceBundle(projectId,lesson.bundleId)!;
    const input={bundle:bundle.bundle,bundleDigest:bundle.digest,lessonId,lessonVersion:1,title:lesson.title,frozenAt:bundle.frozenAt};
    const selected=buildFormalLessonDocument({...input,statementIds:[],questionIds:[questionIds[1]!]});
    expect(selected.scenes.map(item=>item.questionId)).toEqual([questionIds[1]]);
    const legacy={...bundle.bundle,questions:bundle.bundle.questions.map(({snapshot:_snapshot,...rest})=>rest)};
    expect(buildFormalLessonDocument({...input,bundle:legacy}).skipped).toHaveLength(3);
    const large={...bundle.bundle,statements:Array.from({length:30},(_,index)=>({...bundle.bundle.statements[0]!,statementId:`statement-${index}`}))};
    const limited=buildFormalLessonDocument({...input,bundle:large});
    expect(limited.scenes).toHaveLength(24);expect(limited.skipped).toHaveLength(9);
  });

  it('冻结题目修订变化时拒绝旧课件且保留冻结正文',async()=>{
    await create(0);
    const db=createNodeSqliteDriver().open(projectPaths(root).databaseFile);
    try { db.prepare('UPDATE questions SET stem = ?, revision = revision + 1 WHERE question_id = ?').run('后续改写的题目',questionIds[0]); }
    finally { db.close(); }
    const stored=JSON.stringify(session.store.getClassroomDocument(projectId,stageId)!.document);
    expect(stored).toContain('题目-single');expect(stored).not.toContain('后续改写的题目');
    expect((await request(['submit'],submission(0,'A'))).status).not.toBe(200);
    expect(session.store.listAttempts()).toHaveLength(0);
    expect(()=>loadRenderableDocument(session,stageId)).toThrowError(expect.objectContaining({details:expect.objectContaining({reason:'frozen_question_version_mismatch'})}));
  });

  it('侧表偷换为另一道有效题目时复验exact来源绑定',()=>{
    const stored=session.store.getClassroomDocument(projectId,stageId)!;
    session.store.saveClassroomDocument({projectId,stageId,lessonId,recordScope:'formal',dslVersion:stored.dslVersion,document:stored.document,
      digest:stored.digest,sceneCount:stored.sceneCount,
      scenes:[...session.store.listClassroomSceneSources(projectId,stageId).values()].map(item=>({sceneId:item.sceneId,knowledgeIds:item.knowledgeIds,
        questionId:item.sceneId===sceneIds[0]?questionIds[1]!:item.questionId})),reviewedBy:'审核',reviewNote:''});
    expect(()=>loadRenderableDocument(session,stageId)).toThrowError(expect.objectContaining({code:'CLASSROOM_LESSON_NOT_REVIEWED',details:expect.objectContaining({reason:'formal_scene_binding_mismatch'})}));
  });

  it('同时重写文档和digest仍不能绕过冻结审核',()=>{
    const stored=session.store.getClassroomDocument(projectId,stageId)!;
    const document=stored.document as {stage:unknown; scenes:Array<Record<string,unknown>>};
    const changed={...document,scenes:document.scenes.map((scene,index)=>index===0?{...scene,title:'偷换正文'}:scene)};
    session.store.saveClassroomDocument({projectId,stageId,lessonId,recordScope:'formal',dslVersion:stored.dslVersion,document:changed,
      digest:classroomDocumentDigest(changed),sceneCount:stored.sceneCount,
      scenes:[...session.store.listClassroomSceneSources(projectId,stageId).values()].map(item=>({sceneId:item.sceneId,knowledgeIds:item.knowledgeIds,questionId:item.questionId})),
      reviewedBy:'假审核',reviewNote:'假审核'});
    expect(()=>loadRenderableDocument(session,stageId)).toThrowError(expect.objectContaining({code:'VERSION_CONFLICT'}));
  });
});
